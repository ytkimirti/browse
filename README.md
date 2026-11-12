# browse

Drive a real browser one command at a time, and get a log of it: screenshots, transcript, network, and a video with `--video`.

```sh
browse open http://127.0.0.1:3000
browse click 'text=Sign in'
browse fill '#email' me@example.com
browse press '#password' Enter
browse wait 'text=Welcome'          # also an assertion: non-zero if it never shows
browse close                        # prints the session dir
```

Run one command, read the result, decide the next. The browser starts on the
first command and stays alive between them.

## Install

Clone and install directly:

```sh
git clone https://github.com/ytkimirti/browse.git ~/browse
~/browse/bin/browse install
```

`install` puts `browse` on your PATH (`~/.local/bin`), then downloads Playwright
and a browser. Needs Node 18+, and re-running it is safe. `git pull` updates it.
Agents need no skill: `browse help` opens with the rules they need.

Playwright dependencies land in `~/.browse`; browser binaries go to Playwright's
shared cache, so one you already downloaded for another project is reused.

The repository also builds an installable npm package for macOS and Linux.
No registry publication is needed to install a local build:

```sh
npm pack --ignore-scripts --pack-destination /tmp
npm install -g /tmp/ytkimirti-browse-0.1.0.tgz
browse install
```

Installation runs no lifecycle scripts and downloads no browser automatically;
`browse install` performs setup. `browse help` and `browse version` work before setup.
Use `npm run test:package` to verify the packed file list and a fresh local install.
This package has not been published to the npm registry.

## Every session leaves

```
~/.browse/sessions/<when>/
  recording.mp4      with --video: cursor and keystrokes drawn in, dead air cut
  transcript.md      what was run, what came back
  shots/             a screenshot per step
  network.jsonl      requests, credentials redacted
```

## Record on a throwaway machine

A browser, a dev server and ffmpeg are the heaviest things an agent runs.
`browse box` moves all three onto a disposable [Upstash
Box](https://upstash.com/docs/box) and brings the artifacts back here. Two lines,
once:

```sh
browse box key      # prompts for a Box API key from console.upstash.com (starts with box_)
browse box up       # first run bakes a reusable image (~6 min); every one after is ~13s
```

`up` prints the host to pass as `--remote`, and `browse box help` shows a whole
session end to end. `browse box down` deletes it. Nothing is billed once the box
is gone, and the image that makes `up` fast costs cents a month.

## Beyond the basics

Stay logged in across sessions with a profile. Force an error path or an empty
list with request middleware. Freeze the clock before the app's JS runs.
Drop to Playwright code in the live session (raw CDP, HAR replay, WebSocket frames)
with `browse run`.
Scope accessibility snapshots to a region, keep controls with compact output,
and use snapshot element references directly in actions. Deliberately opened
tabs join the recording while active; popup footage stays excluded until selected.
Existing Chromium browsers can be attached over CDP (no video),
keeping their tabs open when browse disconnects. See help for flags and limitations.

`browse help` is an index, `browse help <command>` one command in full, `browse help --all`
every command and flag, `browse help --env` every env var.

MIT
