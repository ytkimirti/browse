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
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statfsSync, writeFileSync, chmodSync, statSync } from "node:fs";
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
  // --timeout is the one flag they DO take now: a hung click used to burn the
  // caller's whole budget because only `wait` could bound one.
  works("click takes --timeout", ["click", "#btn", "--timeout", "5000"], /^ok/);
  fails("...but not a non-numeric one", ["click", "#btn", "--timeout", "abc"], /--timeout wants milliseconds/);
  fails("hover rejects an unknown flag", ["hover", "#btn", "--nope"], /unexpected argument '--nope'/);
  // Stripping the pair off `press '#sel' --timeout N` left a lone selector, and
  // press's one-arg form then sent it to the keyboard AS A KEY.
  fails("press <selector> --timeout is refused, not pressed as a key",
    ["press", "#in", "--timeout", "5000"], /--timeout belongs to the element form/);
  fails("...and so is a page-level press with one", ["press", "Escape", "--timeout", "5000"],
    /waits for nothing, so it takes no timeout/);
  works("press <selector> <key> --timeout still works", ["press", "#in", "a", "--timeout", "5000"], /^ok/);
  // A single dash was the hole: `wait`/`screenshot` reject any leading dash, so
  // act commands must too, and a stray bare word is the same silent drop.
  fails("click rejects a SINGLE-dash flag", ["click", "#btn", "-timeout", "3000"], /unexpected argument '-timeout'/);
  fails("click rejects a stray bare argument", ["click", "#btn", "junk"], /unexpected argument 'junk'/);
  fails("--dialog with no value says the value is missing", ["click", "#btn", "--dialog"], /--dialog needs a value/);
  check("no rejected click reached the page (only the --timeout one did)",
    read("document.getElementById('clicks').textContent") === "4",
    read("document.getElementById('clicks').textContent"));
  works("--dialog with a good value still works", ["click", "#btn", "--dialog", "accept"]);
  check("the one accepted click did reach the page",
    read("document.getElementById('clicks').textContent") === "5",
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

  /* ------------------------------------------- a load the page overwrites */
  // The one that cost a whole session: `state --load` restores the cookies, the
  // page reloads, the app mints its OWN session cookie over the top, and the
  // command still reports "loaded N cookies" while the browser sits logged out.
  console.log("\na merged state the page overwrites says so");
  const STATEFILE = join(OUT, "cookies.json");
  works("open a page that mints its own cookie", ["goto", `${BASE}/cookie`], /ok/);
  const savedSeq = read("document.cookie.replace(/.*sess=/, '')");
  works("save that state", ["state", "--save", STATEFILE], /saved 1 cookie across 1 domain/);
  works("reload, so the page mints a newer one", ["goto", `${BASE}/cookie`], /ok/);
  check("...and it really is newer", read("document.cookie.replace(/.*sess=/, '')") !== savedSeq,
    `${savedSeq} -> ${read("document.cookie.replace(/.*sess=/, '')")}`);
  const merged = browse("state", "--load", STATEFILE);
  check("a merge load exits 0", merged.code === 0, `exit ${merged.code} · ${merged.err}`);
  check("...and reports what the page replaced", /replaced or dropped 1 of them/.test(merged.out), merged.out);
  check("...and points at --clean", /--clean/.test(merged.out), merged.out);
  const cleaned = browse("state", "--load", STATEFILE, "--clean");
  check("--clean loads with no such note", cleaned.code === 0 && !/replaced or dropped/.test(cleaned.out),
    `exit ${cleaned.code} · ${cleaned.out}`);

  /* ----------------------------------------------------- right click */
  // A context menu is the one interaction eval cannot fake: a synthetic
  // `contextmenu` event reaches a React handler but not a menu the browser
  // itself opens, and every other act command rejects a second argument, so
  // there was nowhere to put "with the right button".
  console.log("\nrightclick");
  works("navigate back to the ui fixture", ["goto", `${BASE}/ui`], /ok/);
  check("the menu starts closed", read("document.getElementById('ctxmenu').textContent") === "closed",
    read("document.getElementById('ctxmenu').textContent"));
  works("rightclick", ["rightclick", "#ctx"], /^ok/);
  check("...and the page's contextmenu handler fired",
    read("document.getElementById('ctxmenu').textContent") === "open",
    read("document.getElementById('ctxmenu').textContent"));
  fails("rightclick rejects a stray argument", ["rightclick", "#ctx", "--nope", "3000"],
    /unexpected argument '--nope'/);
  works("...but takes --timeout like every other act command", ["rightclick", "#ctx", "--timeout", "5000"], /^ok/);
  fails("rightclick on nothing fails", ["rightclick", "#no-such-thing"], /rightclick|Timeout/);

  /* ------------------------------------------------- a click that does nothing */
  // `ok` is what a click that worked says, so `ok` on a click that landed on a
  // wrapper is the exit-0 lie this suite is about — and it cost a real session a
  // wrong conclusion ("this facet cannot filter") before it was noticed.
  console.log("\na click that changes nothing says so");
  const inert = browse("click", "#inertwrap");
  check("clicking an inert wrapper still exits 0", inert.code === 0, `exit ${inert.code} · ${inert.err}`);
  check("...and says nothing changed", /nothing changed/.test(inert.out), inert.out);
  const real = browse("click", "#btn");
  check("a real button gets no such note", real.code === 0 && !/nothing changed/.test(real.out), real.out);

  /* --------------------------------------------- a snapshot line as a selector */
  // `snapshot` prints `- button "Go":` and pasting that back is the obvious next
  // move; playwright parses it as CSS and dies on the quote, with no hint.
  console.log("\na snapshot line pasted as a selector is named");
  fails("the role= form is suggested", ["click", 'button "Go"'], /role=button\[name="Go"\]/);

  /* ------------------------------------------------- a cut body says what cut it */
  // The cap applies when the body is CAPTURED, so the rest is not kept anywhere
  // and no later flag can print it. A session that needed a 66KB response found
  // that out by watching json.loads fail on a string cut in half, so the marker
  // names the knob and says the request has to be repeated.
  {
    const CAP = `${SESSION}-cap`, CAPOUT = mkdtempSync(join(tmpdir(), "browse-cap-"));
    const cap = (...a) => browseIn(CAP, CAPOUT, { BROWSE_NET_BODY_MAX: "8" }, a);
    console.log("\na network body cut at the cap says so");
    try {
      check("a session with a tiny body cap", cap("open", `${BASE}/`).code === 0);
      cap("wait", "#done");
      const log = cap("net", "api/user", "--full");
      check("net --full exits 0", log.code === 0, `exit ${log.code} · ${log.err}`);
      check("...and marks the body as cut, with its real size",
        /truncated at 8 of \d+ bytes/.test(log.out), log.out);
      check("...and names the knob and the repeat", /BROWSE_NET_BODY_MAX/.test(log.out)
        && /repeat the request/.test(log.out), log.out);
    } finally {
      cap("close");
      rmSync(CAPOUT, { recursive: true, force: true });
    }
  }

  /* --------------------------------------------- a crash is not blamed on the disk */
  // A renderer that dies because the machine ran out of disk reports a bare
  // "Target crashed", which reads as a browse fault — so browse checks the disk
  // and says so when that is the answer. The other half matters just as much:
  // on a machine with room the message must stay bare, or every crash sends the
  // next command hunting for space that was never the problem. (The full-disk
  // half is verified on a box, where a disk can be filled on purpose.)
  // Its own session: the page really is dead afterwards.
  if (ENGINE === "chromium") {
    const CRASH = `${SESSION}-crash`, CRASHOUT = mkdtempSync(join(tmpdir(), "browse-crash-"));
    const cr = (...a) => browseIn(CRASH, CRASHOUT, {}, a);
    console.log("\na crash on a machine with room does not blame the disk");
    try {
      check("a session to crash", cr("open", `${BASE}/ui`).code === 0);
      cr("goto", "chrome://crash");                       // chromium's own crash url
      const after = cr("text");
      check("the next command fails", after.code === 1, `exit ${after.code} · ${after.out}`);
      check("...saying the page crashed", /crash/i.test(after.err), after.err);
      // Only meaningful on a machine that HAS room — on a full one the note is
      // the correct answer, and asserting its absence would fail for being right.
      let free = Infinity;
      try { const st = statfsSync(CRASHOUT); free = st.bavail * st.bsize; } catch { /* older node */ }
      if (free > 2e9) check("...and says nothing about the disk", !/disk is full/.test(after.err), after.err);
      else console.log(`  skip disk-note absence (only ${Math.round(free / 1e6)}MB free here — the note is correct)`);
    } finally {
      cr("close");
      rmSync(CRASHOUT, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------ --timeout on a typing command */
  // fill/type take their text as DATA, so the flag has to be recognised without
  // eating a value that legitimately starts with a dash.
  console.log("\n--timeout on a typing command");
  {
    browse("goto", `${BASE}/ui`);
    const filled = browse("fill", "#in", "hello", "--timeout", "5000");
    check("fill takes --timeout", filled.code === 0, `exit ${filled.code} · ${filled.err}`);
    check("...without typing the flag into the field",
      browse("eval", "document.getElementById('in').value").out.trim() === "hello",
      browse("eval", "document.getElementById('in').value").out);
  }

  /* ------------------------------------ an ambiguous selector fails fast */
  // Two visible matches means browse is GUESSING which one you meant. When the
  // guess is the one under a modal backdrop, Playwright retries actionability in
  // silence to the full default — two of these cost one real session 7 minutes.
  console.log("\nan ambiguous selector fails fast and names what it matched");
  {
    browse("goto", `${BASE}/ambig`);
    const t0 = Date.now();
    const r = browse("click", "button.go");
    const took = Date.now() - t0;
    check("the click fails", r.code === 1, `exit ${r.code} · ${r.out}`);
    check("...well before the 12s default", took < 11000, `took ${took}ms`);
    check("...naming both matches", /matches 2 elements/.test(r.err), r.err);
    check("...and what is covering the one it tried", /covered by <div#backdrop>/.test(r.err), r.err);
    check("...and how to pick one", /nth=/.test(r.err), r.err);
    check("...and that --timeout waits longer", /--timeout/.test(r.err), r.err);
    const ok = browse("click", "button.go >> nth=1");
    check("nth= disambiguates it", ok.code === 0, `exit ${ok.code} · ${ok.err}`);
    check("...and the modal's button is the one that got clicked",
      /modalbtn/.test(browse("eval", "document.getElementById('clicked').textContent").out),
      browse("eval", "document.getElementById('clicked').textContent").out);
    // The regression the fast path must NOT cause: three identical visible rows
    // are ambiguous too, and completely actionable. Shortening those would break
    // every "click the first row of a list" in the tool.
    const rows = browse("click", "button.row");
    check("an ambiguous but UNCOVERED selector still acts", rows.code === 0, `exit ${rows.code} · ${rows.err}`);
    check("...saying which of them it took", /selector matched 3, acted on the first/.test(rows.out), rows.out);
    check("...and the page saw exactly that one click",
      browse("eval", "document.getElementById('rows').textContent").out.trim() === "1",
      browse("eval", "document.getElementById('rows').textContent").out);
    // An explicit --timeout is how you say "no, wait for it" — and the reply must
    // not then blame the caller for a budget the caller set.
    const explicit = browse("click", "button.go", "--timeout", String(4000));
    check("an explicit --timeout still fails on the covered match", explicit.code === 1, `exit ${explicit.code}`);
    check("...without claiming browse chose the budget",
      !/gave up after/.test(explicit.err), explicit.err);
  }

  /* ----------------------------------- a text= that is really an attribute */
  // `text=` reads text CONTENT. A string the agent read off the screen is often a
  // placeholder, and the failure then reads as "that text is not on the page"
  // about text plainly visible in the screenshot.
  console.log("\na text= selector that is really an attribute says so");
  {
    const r = browse("click", "text=Search country...");
    check("it fails", r.code === 1, `exit ${r.code} · ${r.out}`);
    check("...saying the string is an attribute, not text", /is an attribute/.test(r.err), r.err);
    check("...and naming the attribute selector", /\[placeholder="Search country\.\.\."\]/.test(r.err), r.err);
    const ok = browse("click", '[placeholder="Search country..."]');
    check("...which works", ok.code === 0, `exit ${ok.code} · ${ok.err}`);
    // The hint must stay quiet when the string really IS text on the page: told
    // "that is an attribute" about visible text, an agent goes at the wrong fix.
    const real = browse("click", "text=Rowdy-no-such-thing");
    check("...and says nothing about attributes when there is no such attribute",
      real.code === 1 && !/is an attribute/.test(real.err), real.err);
    // :has-text() and the exact form fail for their own reasons, so they must not
    // get the attribute claim either.
    const hasText = browse("click", 'button:has-text("Search country")');
    check("...nor for :has-text()", hasText.code === 1 && !/is an attribute/.test(hasText.err), hasText.err);
  }

  /* ---------------------------------------------------------- wait --url */
  console.log("\nwait --url says where the page actually is");
  {
    browse("goto", `${BASE}/ui?tab=one`);
    // The glob has to match the WHOLE url, so a pattern that stops at the path
    // never matches one carrying a query — and Playwright's own message names
    // the pattern and not the page, which reads as "it never navigated".
    const r = browse("wait", "--url", "**/ui", "--timeout", "1200");
    check("it fails", r.code === 1, `exit ${r.code} · ${r.out}`);
    check("...naming the url the page is actually on", /\/ui\?tab=one/.test(r.err), r.err);
    check("...and the pattern that would have matched", /\*\*\/ui\*\*/.test(r.err), r.err);
    const ok = browse("wait", "--url", "**/ui**", "--timeout", "2000");
    check("...which does match", ok.code === 0, `exit ${ok.code} · ${ok.err}`);
  }

  /* -------------------------------------------------------- state --save */
  // "saved cookies + localStorage" was equally true of a file holding nothing,
  // and the only way to find out was a python parse of the JSON — on the run
  // whose whole purpose was handing a login to another machine.
  console.log("\nstate --save reports what it captured");
  {
    browse("goto", `${BASE}/ui`);
    const f = join(OUT, "state.json");
    const r = browse("state", "--save", f);
    check("it saves", r.code === 0 && existsSync(f), `exit ${r.code} · ${r.err}`);
    check("...with a countable inventory",
      /\d+ cookies? across \d+ domains? \+ localStorage for \d+ origins?/.test(r.out), r.out);
  }

  /* ------------------------------------------------------------ --no-video */
  // Agents were faking this with BROWSE_FFMPEG=/usr/bin/false, which still pays
  // for the browser-side encode and then merely fails to convert it.
  console.log("\n--no-video");
  {
    const NV = `${SESSION}-novideo`, NVOUT = mkdtempSync(join(tmpdir(), "browse-novid-"));
    const nv = (...args) => browseIn(NV, NVOUT, {}, args);
    try {
      const opened = nv("--no-video", "open", `${BASE}/ui`);
      check("a --no-video session opens", opened.code === 0, `exit ${opened.code} · ${opened.err}`);
      const shot = nv("screenshot", "still.png");
      check("...and still writes screenshots", shot.code === 0 && existsSync(join(NVOUT, "still.png")),
        `exit ${shot.code} · ${shot.out}${shot.err}`);
      // Everything that only means something to a recording has to REFUSE here,
      // not accept and do nothing.
      const sp = nv("speed", "4");
      check("...but speed refuses, instead of annotating a video that will not exist",
        sp.code === 1 && /no-video/.test(sp.err), `exit ${sp.code} · ${sp.err}`);
      const gif = nv("close", "--gif");
      check("...and close --gif refuses too", gif.code === 1 && /no-video/.test(gif.err),
        `exit ${gif.code} · ${gif.err}`);
      const c = nv("close", 120000);
      check("close says the video was off, not that something failed",
        c.code === 0 && /video was off/.test(c.out) && !/ffmpeg/.test(c.out), `exit ${c.code} · ${c.out}${c.err}`);
      check("...and wrote no mp4", !existsSync(join(NVOUT, "recording.mp4")), readdirSync(NVOUT).join(" "));
      check("...and no leftover empty one either",
        !readdirSync(NVOUT).some((f) => f.endsWith(".mp4")), readdirSync(NVOUT).join(" "));
      check("...and no raw webm either", !existsSync(join(NVOUT, "video")), readdirSync(NVOUT).join(" "));
      check("...but kept the transcript", existsSync(join(NVOUT, "transcript.md")), readdirSync(NVOUT).join(" "));
    } finally {
      rmSync(NVOUT, { recursive: true, force: true });
    }
  }

  /* -------------------------------------------- how the mp4 finalize fails */
  // Two sessions on a real remote reported "ffmpeg missing/failed" from a box
  // where ffmpeg was installed and working: the 16-branch filter_complex was
  // OOM-killed on a 3.4 GB machine. Both halves of that are covered here with a
  // wrapper ffmpeg that fails the way the kernel does — by signal.
  console.log("\nthe mp4 finalize when ffmpeg dies");
  {
    const REAL = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
    if (!REAL) console.log("  skip (no system ffmpeg to wrap)");
    else {
      const wrapper = (name, body) => {
        const path = join(OUT, name);
        writeFileSync(path, `#!/bin/sh\n${body}\nexec ${REAL} "$@"\n`);
        chmodSync(path, 0o755);
        return path;
      };
      // a) EVERY encode dies on a signal (probing -version/-filters still works,
      //    which is exactly the state that made this look like a missing binary).
      {
        const oom = wrapper("ffmpeg-oom.sh",
          `case " $* " in *" -version "*|*" -filters "*) ;; *) kill -9 $$ ;; esac`);
        const S = `${SESSION}-oom`, O = mkdtempSync(join(tmpdir(), "browse-oom-"));
        const b = (...args) => browseIn(S, O, { BROWSE_FFMPEG: oom }, args);
        try {
          b("open", `${BASE}/ui`);
          b("wait", "1200");
          const c = b("close", 180000);
          check("close still succeeds", c.code === 0, `exit ${c.code} · ${c.err}`);
          check("...and blames the signal, not a missing ffmpeg",
            /killed by SIG/.test(c.out) && !/ffmpeg missing/.test(c.out), c.out);
          check("...and says how much memory was free", /free of /.test(c.out), c.out);
          check("...and keeps the webm as the recording", /webm:/.test(c.out), c.out);
        } finally { rmSync(O, { recursive: true, force: true }); }
      }
      // b) only the N-branch graph dies — which is the real box's failure — so
      //    the segment-wise retry has to produce the mp4 unattended.
      {
        const nograph = wrapper("ffmpeg-nograph.sh",
          `case " $* " in *" -filter_complex "*) kill -9 $$ ;; esac`);
        const S = `${SESSION}-seg`, O = mkdtempSync(join(tmpdir(), "browse-seg-"));
        const b = (...args) => browseIn(S, O, { BROWSE_FFMPEG: nograph }, args);
        try {
          b("open", `${BASE}/ui`);
          // Almost the whole clip is ONE 2x speed region, so its length is what
          // the output duration is made of. That is deliberate: the first version
          // of this fallback cut each segment with output-side -ss/-t, which runs
          // AFTER the setpts retime and silently wrote a ZERO-frame part for
          // every sped segment — ffmpeg exits 0, concat swallows it, and the mp4
          // comes out looking fine to any existence check. Only a duration
          // assertion catches that.
          b("speed", "2");
          b("scroll", "200");
          b("wait", "4000");
          b("scroll", "-200");
          b("speed", "off");
          const c = b("close", 300000);
          check("close succeeds", c.code === 0, `exit ${c.code} · ${c.err}`);
          check("...and still hands back an mp4", /mp4:/.test(c.out), c.out);
          const mp4 = join(O, "recording.mp4");
          check("...that exists and is not empty",
            existsSync(mp4) && statSync(mp4).size > 1000, readdirSync(O).join(" "));
          const dlog = existsSync(join(O, "browsed.log")) ? readFileSync(join(O, "browsed.log"), "utf8") : "";
          check("...written by the segment-wise retry", /retrying segment-wise/.test(dlog),
            dlog.split("\n").slice(-4).join("\n"));
          // >4s of real time at 2x is at least 2s of video, and the lead-in/tail
          // keeps are short. Under the dropped-segment bug the sped stretch
          // contributes NOTHING and this lands near zero. Only a lower bound: how
          // much real time the keeps add is a property of the machine, so an
          // upper bound tight enough to mean anything would be flaky (the same
          // session measures 3s here and 7s on a slow remote).
          const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", mp4], { encoding: "utf8" });
          const dur = Number((probe.stdout || "").trim());
          check("...carrying the sped-up stretch, retimed, not dropped",
            Number.isFinite(dur) && dur > 1.5, `duration=${probe.stdout || probe.stderr}`);
          check("...leaving no segment temp files behind",
            !readdirSync(O).some((f) => f.startsWith(".seg-") || f === ".segments.txt"), readdirSync(O).join(" "));
        } finally { rmSync(O, { recursive: true, force: true }); }
      }
    }
  }

  /* ---------------------------------------------- the page that never woke */
  // A dev server reached over 127.0.0.1: the document arrives, nothing hydrates
  // it, and every observe command comes back empty with no reason given. One
  // recorded session spent ten minutes on this. The hint has to be reachable
  // from BOTH dead ends: an empty read, and a selector that never appears.
  console.log("\nthe unhydrated page");
  {
    browse("goto", `${BASE}/unhydrated`);
    const t = browse("text");
    check("text on an unhydrated page still exits 0", t.code === 0, `exit ${t.code} · ${t.err}`);
    check("...and names the cause instead of guessing mid-load",
      /never hydrated|nothing hydrated it/.test(t.out + t.err), `${t.out}${t.err}`);
    check("...and points at localhost, with the url to re-open",
      /browse goto http:\/\/localhost:/.test(t.out + t.err), `${t.out}${t.err}`);
    const w = browse("wait", "#never-arrives", "--timeout", "2000");
    check("a wait that times out there fails, exit 1", w.code === 1, `exit ${w.code} · ${w.out}`);
    check("...and carries the same diagnosis", /nothing hydrated it/.test(w.err), w.err);
    // The opposite case is the one that matters most: a page that DID hydrate
    // must never be accused of this.
    browse("goto", `${BASE}/ui`);
    const ok = browse("text", "#clicks");
    check("a live page is never diagnosed as unhydrated", !/hydrated it/.test(ok.out + ok.err), `${ok.out}${ok.err}`);
  }

  /* ------------------------------------------------------- screenshot --pad */
  // An element shot clips to the border box, so an overflowing caption came back
  // sliced with nothing saying so, and the way out was to guess an ancestor.
  console.log("\nscreenshot --pad");
  {
    browse("goto", `${BASE}/ui`);
    const dims = (f) => {
      const b = readFileSync(join(OUT, f));
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    const bare = browse("screenshot", "pad-none.png", "--sel", "#btn");
    check("an element shot works", bare.code === 0 && existsSync(join(OUT, "pad-none.png")),
      `exit ${bare.code} · ${bare.err || bare.out}`);
    const padded = browse("screenshot", "pad-24.png", "--sel", "#btn", "--pad", "24");
    check("...and --pad works too", padded.code === 0 && /\+ 24px/.test(padded.out),
      `exit ${padded.code} · ${padded.err || padded.out}`);
    const a = dims("pad-none.png"), b = dims("pad-24.png");
    check("...and the padded png really is bigger on both axes",
      b.w > a.w && b.h > a.h, `${a.w}x${a.h} vs ${b.w}x${b.h}`);
    const noSel = browse("screenshot", "pad-nosel.png", "--pad", "24");
    check("--pad without --sel fails rather than shooting the page",
      noSel.code === 1 && /--sel/.test(noSel.err) && !existsSync(join(OUT, "pad-nosel.png")),
      `exit ${noSel.code} · ${noSel.err}`);
    const bad = browse("screenshot", "pad-bad.png", "--sel", "#btn", "--pad", "lots");
    check("--pad with a non-number fails", bad.code === 1 && /whole pixels/.test(bad.err),
      `exit ${bad.code} · ${bad.err}`);
    const withFull = browse("screenshot", "pad-full.png", "--sel", "#btn", "--pad", "8", "--full");
    check("--pad with --full is refused, not silently resolved",
      withFull.code === 1 && /pick one/.test(withFull.err), `exit ${withFull.code} · ${withFull.err}`);
    // Zero is a value, not an absent flag: guarding on truthiness let `--pad 0`
    // past both checks above and shot the whole viewport at exit 0.
    const zero = browse("screenshot", "pad-zero.png", "--pad", "0");
    check("--pad 0 without --sel is refused too, not treated as no flag at all",
      zero.code === 1 && /--sel/.test(zero.err) && !existsSync(join(OUT, "pad-zero.png")),
      `exit ${zero.code} · ${zero.err}`);
    // A .pdf name prints the whole page: there is no element form, so accepting
    // these and printing a full page at exit 0 is the wrong artifact, silently.
    const pdf = browse("screenshot", "one.pdf", "--sel", "#btn", "--pad", "8");
    check("a .pdf name refuses the element flags instead of ignoring them",
      pdf.code === 1 && /whole page/.test(pdf.err) && !existsSync(join(OUT, "one.pdf")),
      `exit ${pdf.code} · ${pdf.err}`);
  }

  /* ------------------------------------------------- init --stub clipboard */
  // Headless denies navigator.clipboard, so a "Copy" button never reaches its
  // "Copied!" state and that state cannot be photographed at all.
  console.log("\ninit --stub clipboard");
  {
    browse("goto", `${BASE}/copy`);
    browse("click", "#copy");
    check("without the stub the page reports the denial",
      /denied/.test(read("document.getElementById('badge').textContent")),
      read("document.getElementById('badge').textContent"));
    const bad = browse("init", "--stub", "notathing");
    check("an unknown stub fails and lists the real ones",
      bad.code === 1 && /available: clipboard/.test(bad.err), `exit ${bad.code} · ${bad.err}`);
    const reg = browse("init", "--stub", "clipboard");
    check("the clipboard stub registers", reg.code === 0, `exit ${reg.code} · ${reg.err}`);
    const list = browse("init");
    check("...labelled, so a faked 'Copied!' is legible as one",
      /stub:clipboard/.test(list.out), list.out);
    browse("reload");
    browse("click", "#copy");
    check("...and the copied state is now reachable",
      /copied/.test(read("document.getElementById('badge').textContent")),
      read("document.getElementById('badge').textContent"));
    check("...with the copied text kept for the next assertion",
      /the migration prompt/.test(read("window.__clipboard")), read("window.__clipboard"));
    browse("init", "--clear");
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
