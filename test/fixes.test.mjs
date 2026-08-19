#!/usr/bin/env node
// Regression coverage for the bugs found by replaying old recorded sessions
// against the CLI. Drives the REAL binary against test/fixture-server.mjs and
// asserts stdout AND exit status for both the success and the failure path.
//
//   node test/fixes.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/fixes.test.mjs
//
// The rule every case here encodes: a command that cannot do what was asked
// must FAIL, not report success. Most of these bugs were exit-0 lies — a click
// that never reached the page, a caption that never rendered, a mock colour that
// silently became yellow — which is the one failure an agent cannot see.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `fixtest-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-fixes-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

function browseIn(session, out, extraEnv, args, ms = 180000) {
  const r = spawnSync(BIN, ["-s", session, ...args], {
    encoding: "utf8",
    env: {
      ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: out,
      BROWSE_HEADFUL: "0", BROWSE_IDLE_MS: "120000", ...extraEnv,
    },
    timeout: ms,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function browse(...args) {
  let ms = 180000;
  if (typeof args[args.length - 1] === "number") ms = args.pop();
  return browseIn(SESSION, OUT, {}, args, ms);
}

let fixture = null, cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { browse("close"); } catch { /* best effort */ }
  try { fixture?.kill(); } catch { /* already gone */ }
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* best effort */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

const fails = (label, args, re) => {
  const r = browse(...args);
  check(label, r.code === 1 && re.test(r.err), `exit ${r.code} · ${r.err || r.out}`);
};
const works = (label, args, re = /.?/) => {
  const r = browse(...args);
  check(label, r.code === 0 && re.test(r.out), `exit ${r.code} · ${r.err || r.out}`);
};
/** Read page state back. The assertion that matters is almost never the command's
 *  own output — it is whether the PAGE changed. */
const read = (expr) => browse("eval", expr).out;

console.log(`browse fixes — engine ${ENGINE}, session ${SESSION}`);
let BASE;
try {
  fixture = spawn(process.execPath, [join(ROOT, "test", "fixture-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  BASE = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("fixture server never came up")), 10000);
    fixture.stdout.on("data", (c) => {
      buf += c;
      const m = /PORT (\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
  });
  console.log(`origin ${BASE}\n`);

  /* ---------------------------------------------------------------- client */
  // Refusing a knowably-wrong command in the CLIENT is what keeps it from
  // launching a browser and starting a recording just to say no.
  console.log("refused without a browser");
  fails("an unknown command is refused", ["clcik", "#x"], /unknown command 'clcik'/);
  fails("`evaluate` points at eval", ["evaluate", "1+1"], /'evaluate' was removed.*browse eval/);
  fails("a retired flag is refused", ["screenshot", "x.png", "--fullpage"], /'--fullpage' was removed/);
  // The retired-flag table is keyed by COMMAND: `net --domain` is answered in
  // the client before the daemon is ever reached, so it needs its own pointer.
  fails("net --domain points at --host", ["net", "--domain", "example.com"], /'--domain' was removed.*--host/);
  check("none of that spawned a browser", browse("whoami").out.includes("not running"), browse("whoami").out);

  console.log("\nlive session");
  works("open", ["open", `${BASE}/ui`], /opened/);

  /* ------------------------------------------------------------------ drag */
  // The critical one: a drag that failed AFTER mouse.down() left the button held
  // on a draggable element, and Chromium then swallowed every later click and
  // hover while each still reported ok.
  console.log("\ndrag leaves no button held");
  works("a click registers before any drag", ["click", "#btn"]);
  check("...and the page saw it", read("document.getElementById('clicks').textContent") === "1", read("document.getElementById('clicks').textContent"));
  fails("a drag with a bad TARGET fails, naming the target",
    ["drag", "#src", "#no-such-target"], /drag: target '#no-such-target'/);
  fails("drag rejects a stray flag", ["drag", "#src", "#drop", "--timeout", "3000"],
    /unexpected argument '--timeout'/);
  works("a click still works after that", ["click", "#btn"]);
  check("...and the page really saw it (mouse not stuck)",
    read("document.getElementById('clicks').textContent") === "2",
    `clicks = ${read("document.getElementById('clicks').textContent")} (1 means input is dead)`);
  fails("a drag with a bad SOURCE fails, naming the source",
    ["drag", "#no-such-source", "#drop"], /drag: source '#no-such-source'/);
  works("a click still works after that too", ["click", "#btn"]);
  check("...and the page saw that one",
    read("document.getElementById('clicks').textContent") === "3",
    `clicks = ${read("document.getElementById('clicks').textContent")}`);
  works("a real drag still drops", ["drag", "#src", "#drop"], /dragged/);
  check("...and the drop handler fired", read("document.getElementById('dropped').textContent") === "yes",
    read("document.getElementById('dropped').textContent"));

  /* ------------------------------------------------- stale hidden matches */
  // A closed dialog that stays mounted (Ant Design, Radix forceMount) puts an
  // invisible twin of the same input and button EARLIER in the DOM. `.first()`
  // is document order, so the action used to spend its whole timeout scrolling
  // the page toward an element nobody can see, and then blamed the selector.
  console.log("\nhidden twins do not win over what is on screen");
  works("fill picks the visible dialog", ["fill", "[role=dialog] input.confirm", "typed"],
    /1 hidden - acted on the first visible/);
  check("...and the visible field got the text",
    read("document.querySelector('.live input.confirm').value") === "typed",
    `live='${read("document.querySelector('.live input.confirm').value")}' ghost='${read("document.querySelector('.ghost input.confirm').value")}'`);
  check("...and the hidden twin was left alone",
    read("document.querySelector('.ghost input.confirm').value.length") === "0",
    read("document.querySelector('.ghost input.confirm').value"));
  works("click picks the visible dialog too", ["click", "[role=dialog] button.go"],
    /1 hidden - acted on the first visible/);
  check("...and the page saw exactly one click", read("window.__go") === "1", read("window.__go"));
  fails("all-hidden matches fail saying so, not 'no such element'",
    ["click", ".allhidden button.nope"], /every element matching this selector is hidden \(2 matched\)/);

  /* ------------------------------------------------------------ screenshot */
  console.log("\nscreenshot names");
  works("a bare name is saved as .png", ["screenshot", "checkout"], /checkout\.png/);
  check("...and the file is on disk", existsSync(join(OUT, "checkout.png")), readdirSync(OUT).join(" "));
  works("an explicit .png still works", ["screenshot", "explicit.png"], /explicit\.png/);
  // Playwright's mime lookup is case-SENSITIVE, so accepting .PNG without
  // lowercasing it reproduced the exact raw error this fix removed.
  works("an uppercase extension is normalised", ["screenshot", "UPPER.PNG"], /UPPER\.png/);
  check("...and that file exists", existsSync(join(OUT, "UPPER.png")), readdirSync(OUT).join(" "));
  works("a name with dots keeps them", ["screenshot", "v1.2-checkout"], /v1\.2-checkout\.png/);
  works("--sel with a bare name works", ["screenshot", "region", "--sel", "#btn"], /region\.png/);

  /* ----------------------------------------------------- act command flags */
  // Extras used to land in Playwright's options slot as strings and be dropped,
  // so `click x --timeout 3000` waited the default and exited 0 regardless.
  console.log("\nact commands reject unknown flags");
  fails("click rejects an unknown flag", ["click", "#btn", "--bogus"], /unexpected argument '--bogus'/);
  fails("click rejects --timeout (it is a wait flag)", ["click", "#btn", "--timeout", "3000"], /unexpected argument '--timeout'.*browse wait/s);
  fails("hover rejects an unknown flag", ["hover", "#btn", "--nope"], /unexpected argument '--nope'/);
  // A single dash was the hole: `wait`/`screenshot` reject any leading dash, so
  // act commands must too, and a stray bare word is the same silent drop.
  fails("click rejects a SINGLE-dash flag", ["click", "#btn", "-timeout", "3000"], /unexpected argument '-timeout'/);
  fails("click rejects a stray bare argument", ["click", "#btn", "junk"], /unexpected argument 'junk'/);
  fails("--dialog with no value says the value is missing", ["click", "#btn", "--dialog"], /--dialog needs a value/);
  check("no rejected click reached the page",
    read("document.getElementById('clicks').textContent") === "3",
    read("document.getElementById('clicks').textContent"));
  works("--dialog with a good value still works", ["click", "#btn", "--dialog", "accept"]);
  check("the one accepted click did reach the page",
    read("document.getElementById('clicks').textContent") === "4",
    read("document.getElementById('clicks').textContent"));
  // Commands whose trailing args are DATA must still accept a dashed value -
  // rejecting those was the over-correction this section guards against.
  works("fill still accepts a dashed value", ["fill", "#in", "--not-a-flag"]);
  check("...and the value really landed", read("document.getElementById('in').value") === "--not-a-flag",
    read("document.getElementById('in').value"));
  works("type still accepts a dashed value", ["type", "#in", "-t"]);
  works("selectOption accepts a '--' option value", ["selectOption", "#sel", "--"], /ok/);
  check("...and the select really changed", read("document.getElementById('sel').value") === "--",
    read("document.getElementById('sel').value"));
  // A dash-leading screenshot NAME stays refused on purpose (a mistyped flag
  // must never become a filename), but the message has to say which flag set is
  // valid rather than pointing at a retired `wait` flag.
  fails("a dash-shaped screenshot name is refused as a flag", ["screenshot", "-t"], /screenshot: unknown flag '-t'.*--full/);
  works("text accepts a selector that looks like a dead flag", ["text", "#in"], /.?/);
  fails("setInputFiles still names a missing dashed path", ["setInputFiles", "#file", "--nope.txt"], /no such file: --nope\.txt/);

  /* ------------------------------------------------------------------ eval */
  console.log("\neval");
  works("undefined prints something", ["eval", "undefined"], /^undefined$/);
  works("await is wrapped, not a SyntaxError",
    ["eval", "await new Promise(r => setTimeout(() => r('async-ok'), 100))"], /async-ok/);
  works("a promise still auto-awaits", ["eval", "Promise.resolve('promise-ok')"], /promise-ok/);
  fails("an empty expression is an error", ["eval", ""], /needs a js expression/);
  const big = browse("eval", "document.getElementById('long').textContent");
  check("a huge result is truncated WITH a notice",
    big.code === 0 && /eval truncated: \d+ of \d+ chars/.test(big.out) && big.out.length < 12000,
    `${big.out.length} bytes · tail: ${big.out.slice(-120)}`);
  const small = browse("eval", "'short'");
  check("a small result is untouched", small.out === "short", small.out);
  works("an empty string prints as \"\" rather than nothing", ["eval", "''"], /^""$/);
  // The cap counts UTF-16 units, so a cut landing inside a surrogate pair used
  // to emit a lone one and print as U+FFFD.
  const emoji = browse("eval", "'a'.repeat(7999) + '\\u{1F600}'.repeat(5)");
  check("truncation does not split a surrogate pair", !emoji.out.includes("�"),
    `tail: ${JSON.stringify(emoji.out.slice(7990, 8010))}`);
  fails("a rejected promise still fails", ["eval", "Promise.reject(new Error('boom'))"], /boom/);
  fails("an await STATEMENT says browse rewrote it",
    ["eval", "const r = await fetch('/ui'); r.status"], /async IIFE/);

  /* ---------------------------------------------------------- read clipping */
  console.log("\nbounded reads say they are bounded");
  const text = browse("text", "body");
  check("text truncation is announced", /text truncated: \d+ of \d+ chars/.test(text.out), text.out.slice(-160));
  const content = browse("content");
  check("content truncation is announced", /content truncated: \d+ of \d+ chars/.test(content.out), content.out.slice(-160));

  /* ----------------------------------------------------------------- toast */
  console.log("\ntoast validates what it is given");
  works("a normal toast works", ["toast", "hello from the test"], /toast \(auto-dismiss\)/);
  fails("no text is an error", ["toast"], /needs the caption text/);
  fails("an unknown --color is an error", ["toast", "x", "--color", "purple"], /unknown --color 'purple'.*yellow/);
  fails("an unknown --pos is an error", ["toast", "x", "--pos", "middle"], /unknown --pos 'middle'.*top/);
  fails("a non-numeric --for is an error", ["toast", "x", "--for", "abc"], /--for expects seconds/);
  works("--clear with no toast is still fine", ["toast", "--clear"], /toast cleared/);
  // Validating flags must not cost a caption its leading dashes.
  works("-- ends the flags so a caption can start with one",
    ["toast", "--", "--important: read this"], /--important: read this/);
  check("...and it really rendered",
    read("document.querySelector('[id*=toast]')?.textContent || ''").includes("--important"),
    read("document.querySelector('[id*=toast]')?.textContent || ''"));
  works("clear it again", ["toast", "--clear"], /toast cleared/);

  /* ---------------------------------------------------------------- scroll */
  console.log("\nscroll needs a target");
  fails("a bare scroll is an error", ["scroll"], /needs a target/);
  fails("an explicit scroll 0 is an error too", ["scroll", "0"], /moves nothing/);
  fails("an unknown scroll flag is an error", ["scroll", "100", "--nope"], /unknown flag '--nope'/);
  works("scroll bottom still works", ["scroll", "bottom"], /scrolled bottom/);
  const shotsAfterScroll = readdirSync(join(OUT, "shots"));
  check("the refused scroll took no step screenshot",
    shotsAfterScroll.filter((f) => f.includes("scroll")).length === 1,
    shotsAfterScroll.join(" "));

  /* ----------------------------------------------------------------- speed */
  console.log("\nspeed");
  fails("closing nothing is an error", ["speed", "off"], /no fast-forward region is open/);
  works("a region opens", ["speed", "4"], /speed: 4x/);
  works("...and closes", ["speed", "off"], /back to real time/);
  fails("closing it twice is an error", ["speed", "off"], /no fast-forward region is open/);

  /* --------------------------------------------------------------- emulate */
  console.log("\nemulate off really resets");
  works("geo= applies", ["emulate", "geo=41.0,29.0"], /geo=41,29/);
  const geoExpr = "new Promise(r => navigator.geolocation.getCurrentPosition(p => r(p.coords.latitude + ',' + p.coords.longitude), () => r('denied')))";
  check("...and the page sees it", read(geoExpr).startsWith("41"), read(geoExpr));
  works("off resets everything", ["emulate", "off"], /back to default/);
  check("...including geolocation", !read(geoExpr).startsWith("41"), read(geoExpr));
  works("locale= discloses that it is Intl-only", ["emulate", "locale=tr-TR"], /Intl only.*navigator\.language/s);
  works("emulate off again", ["emulate", "off"]);

  /* ------------------------------------------------------------ iframe eval */
  console.log("\neval honours an iframe scope");
  works("scope into the iframe", ["target", "iframe#frame"], /scoped into/);
  works("text reads inside it", ["text", "#fs"], /inside-the-frame/);
  works("eval now reads inside it too", ["eval", "location.pathname"], /^\/frame$/);
  works("leave the frame", ["target", "top"], /top frame/);
  works("eval is back on the top document", ["eval", "location.pathname"], /^\/ui$/);

  /* ------------------------------------------------------------- popup note */
  console.log("\npopup switch is reported by the command that caused it");
  // On chromium, target=_blank is rewritten to same-tab navigation by default
  // (POPUPS) so the recording stays on the recorded tab. Assert that first, then
  // test the real-popup path in its own session with BROWSE_POPUPS=1.
  const sameTab = browse("click", "#blank");
  check("by default the new tab is rewritten to same-tab", sameTab.code === 0 && /popup=1/.test(sameTab.out), sameTab.out);
  check("...so no popup tab was opened", !/switched to popup tab/.test(browse("target").out), browse("target").out);
  works("back to the fixture", ["goto", `${BASE}/ui`], /./);

  const POP = `${SESSION}-pop`, POPOUT = mkdtempSync(join(tmpdir(), "browse-pop-"));
  const pop = (...args) => browseIn(POP, POPOUT, { BROWSE_POPUPS: "1" }, args);
  try {
    pop("open", `${BASE}/ui`);
    const popup = pop("click", "#blank");
    // The page event lands after click() resolves, so this note used to arrive
    // on the NEXT command while the click reported the tab it had just left.
    check("the click that opens a popup reports it", /switched to popup tab/.test(popup.out),
      `out=${JSON.stringify(popup.out)}\ntabs:\n${pop("target").out}`);
    check("...and its status line is the popup, not the old tab", /popup=1/.test(popup.out), popup.out);
    check("...and the popup really is a second tab", /\n\*? ?1 /.test(pop("target").out), pop("target").out);
  } finally {
    pop("close");
    rmSync(POPOUT, { recursive: true, force: true });
  }

  /* -------------------------------------------------------- friendly ENOENT */
  console.log("\nmissing files are named, not ENOENT");
  fails("state --load lists what IS saved", ["state", "--load", "definitely-not-saved.json"],
    /no saved state 'definitely-not-saved\.json'/);
  fails("setInputFiles names the missing path", ["setInputFiles", "#src", "/tmp/browse-no-such-file.txt"],
    /no such file: \/tmp\/browse-no-such-file\.txt/);

  /* ------------------------------------------------------------- transcript */
  console.log("\ntranscript");
  works("a long read for the transcript", ["snapshot"], /./);
  const tr = readFileSync(join(OUT, "transcript.md"), "utf8");
  // The marker must not claim the command printed everything: the reply itself
  // may already have been capped by clipForRead.
  check("a cut result says it was cut", /more lines not kept in this transcript/.test(tr),
    tr.split("\n").slice(-6).join("\n"));
  check("...without claiming the command printed it all",
    !/printed them in full/.test(tr), "transcript still promises the full output");
  check("...and keeps more than three lines of it",
    tr.split("\n### ").some((s) => s.split("\n").filter((l) => l.startsWith("- ")).length > 3),
    "no block kept more than 3 lines");

  /* --------------------------------------------- the video covers the viewport */
  // Firefox paints at the display's device pixel ratio and writes those device
  // pixels straight into the fixed recordVideo frame, so on a Retina screen the
  // whole recording came out magnified 2x with the right and bottom of the page
  // cut off — while every screenshot stayed correct, which is what made it so
  // hard to see. /corner is green with a blue square pinned bottom-right: sample
  // that corner out of the last recorded frame and the scale is no longer a
  // matter of opinion.
  console.log("\nthe recorded frame covers the whole viewport");
  {
    const VID = `${SESSION}-vid`, VIDOUT = mkdtempSync(join(tmpdir(), "browse-vid-"));
    const vid = (...args) => browseIn(VID, VIDOUT, {}, args);
    try {
      vid("open", `${BASE}/corner`);
      // Move the real pointer: camoufox's own virtual cursor is what the red
      // check below is about, and it is drawn where that pointer is.
      vid("hover", "body");
      vid("wait", "1500");
      vid("close", 300000);
      const mp4 = join(VIDOUT, "recording.mp4");
      // -sseof reads from the end: the first frames can still be the blank
      // lead-in, and the corner only exists once the page has painted.
      const px = spawnSync("ffmpeg", ["-v", "error", "-sseof", "-0.4", "-i", mp4, "-frames:v", "1",
        "-vf", "crop=2:2:iw-20:ih-20", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { encoding: "buffer", maxBuffer: 1e6 });
      const rgb = px.stdout && px.stdout.length >= 3 ? [...px.stdout.subarray(0, 3)] : null;
      // Blue corner = the frame reaches the bottom-right of the viewport. Green
      // there = the frame is a magnified crop of the top-left.
      check("the bottom-right of the page is in the recorded frame",
        !!rgb && rgb[2] > 150 && rgb[1] < 100,
        `sampled rgb=${rgb} from ${mp4} (green there means a magnified crop)`);

      // Camoufox paints its OWN pointer - a red blob - into the content area, so
      // it lands in the mp4 next to the one browse draws. Two cursors on one
      // screen is not a demo anyone can use, so browse launches it with
      // showcursor off. The page here is pure green + blue: any strongly red
      // pixel in the frame is that blob coming back.
      if (ENGINE !== "camoufox") {
        console.log("  skip camoufox's own red pointer (chromium has none)");
      } else {
        const full = spawnSync("ffmpeg", ["-v", "error", "-sseof", "-0.4", "-i", mp4, "-frames:v", "1",
          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
          { encoding: "buffer", maxBuffer: 2e7 });
        const buf = full.stdout || Buffer.alloc(0);
        let red = 0;
        for (let i = 0; i + 2 < buf.length; i += 3)
          if (buf[i] > 150 && buf[i + 1] < 90 && buf[i + 2] < 90) red++;
        check("camoufox's own red pointer is not in the recording",
          buf.length > 0 && red === 0, `${red} red px in ${buf.length / 3} sampled from ${mp4}`);
      }
    } finally {
      rmSync(VIDOUT, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------- recorded window == viewport */
  // camoufox clamps the window it is asked for to the random screen it drew for
  // the fingerprint, so an unconstrained draw could hand back a 960x525 window
  // for a 1280x800 ask. Playwright forces the viewport anyway: the page LAYS OUT
  // at 1280 (screenshots look right) while the recording captures the small
  // window and stretches it to recordVideo.size, i.e. a magnified video with the
  // right and bottom of the page cut off. Assert the two agree, at a viewport
  // large enough that a clamped draw is the common case, not a rare one.
  console.log("\nthe window camoufox drew fits the recording frame");
  if (ENGINE !== "camoufox") {
    console.log("  skip (camoufox only — chromium takes the viewport verbatim)");
  } else {
    const FIT = `${SESSION}-fit`, FITOUT = mkdtempSync(join(tmpdir(), "browse-fit-"));
    const fit = (...args) => browseIn(FIT, FITOUT, { BROWSE_VIEWPORT: "1600x1000" }, args);
    try {
      fit("open", `${BASE}/ui`);
      const win = fit("eval", "[innerWidth, innerHeight, outerWidth, outerHeight].join('x')");
      check("the window matches the 1600x1000 viewport", /1600x1000x1600x1000/.test(win.out),
        `${win.out}\n${readFileSync(join(FITOUT, "browsed.log"), "utf8")}`);
      // Re-rolling a clamped draw is normal; giving up on one is not.
      check("...without giving up and recording a magnified frame",
        !/could not fit a/.test(readFileSync(join(FITOUT, "browsed.log"), "utf8")),
        readFileSync(join(FITOUT, "browsed.log"), "utf8"));
    } finally {
      fit("close");
      rmSync(FITOUT, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------- the pointer drawn */
  // The overlay pointer IS the macOS one: the @2x bitmaps AppKit hands out for
  // NSCursor.arrow / NSCursor.pointingHand, drawn at their true point size with
  // AppKit's hotspot. A lookalike that is a few pixels off reads as "some tool's
  // cursor" in every demo, so the assertions are the exact numbers - which
  // graphic is showing, that it actually PAINTED (a bitmap nobody could decode
  // leaves an invisible pointer, not an error), and that the hotspot lands on
  // what was hovered. Runs on both engines: the overlay used to be off under
  // camoufox, and a video with no pointer in it is the failure that caused.
  console.log("\nthe on-page pointer is the macOS one");
  {
    // Reads the VISIBLE canvas layer: its bitmap size says which graphic, its
    // alpha says whether anything got painted, and its box + the hotspot for
    // that graphic says where the tip actually is, in page coordinates.
    const PTR = (sel) => "(() => {" +
      "const c=[...document.querySelectorAll('#__bc_ptr canvas')].find(x=>x.style.display!=='none');" +
      "if(!c) return 'no-pointer';" +
      "const hand=c.dataset.shape==='pointer', w=hand?32:28, h=hand?[13,8]:[5,5];" +
      "const r=c.getBoundingClientRect(), S=r.width/w;" +
      "const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;" +
      "let ink=0; for(let i=3;i<px.length;i+=4) if(px[i]>200) ink++;" +
      // Opaque pixels in the smaller (1x) rep: 100 for the arrow, 155 for the
      // hand. A third of that still separates a painted pointer from a canvas
      // whose bitmap never decoded, which is the failure this catches.
      "const t=document.querySelector('" + sel + "').getBoundingClientRect();" +
      // Within half a pixel, not exactly on it: the pointer paints on whole
      // pixels (a fractional offset would resample the bitmap and soften it),
      // and an element centre is routinely a .5.
      "return [hand?'hand':'arrow',Math.round(r.width),ink>33," +
      "Math.abs(r.left+h[0]*S-(t.left+t.width/2))<=0.5," +
      "Math.abs(r.top+h[1]*S-(t.top+t.height/2))<=0.5].join(',');})()";
    works("back on the ui page", ["goto", `${BASE}/ui`], /ui/);
    browse("hover", "#btn");
    check("a button gets the macOS pointing hand, painted, fingertip on the button",
      read(PTR("#btn")) === "hand,32,true,true,true", read(PTR("#btn")));
    browse("hover", "#clicks");
    check("plain text gets the macOS arrow, painted, tip on the text",
      read(PTR("#clicks")) === "arrow,28,true,true,true", read(PTR("#clicks")));

    // A 12x19 pointer is honest but small in a video someone watches at half
    // size, so the size is a knob - and scaling it must move the hotspot with
    // it, or the enlarged arrow points somewhere the click did not land.
    const BIG = `${SESSION}-big`, BIGOUT = mkdtempSync(join(tmpdir(), "browse-ptr-"));
    try {
      const big = (...args) => browseIn(BIG, BIGOUT, { BROWSE_CURSOR_SCALE: "2" }, args);
      big("open", `${BASE}/ui`);
      big("hover", "#btn");
      const got = big("eval", PTR("#btn")).out;
      check("BROWSE_CURSOR_SCALE=2 doubles the pointer and keeps the hotspot on target",
        got === "hand,64,true,true,true", got);
    } finally {
      browseIn(BIG, BIGOUT, {}, ["close"]);
      rmSync(BIGOUT, { recursive: true, force: true });
    }
  }

  /* ----------------------------------------------------------------- close */
  console.log("\nclose");
  const closed = browse("close", 300000);
  check("close, exit 0", closed.code === 0, `exit ${closed.code} · ${closed.err || closed.out}`);
  check("the mp4 exists", existsSync(join(OUT, "recording.mp4")), readdirSync(OUT).join(" "));
  const log = readFileSync(join(OUT, "browsed.log"), "utf8");
  check("the daemon never crashed", !/Unhandled|UnhandledPromiseRejection/.test(log),
    log.split("\n").filter((l) => /Unhandled/.test(l)).join("\n"));
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
