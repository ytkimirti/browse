# browse

Drive a real browser one command at a time, and get a video of it.

```sh
browse open http://127.0.0.1:3000
browse click 'text=Sign in'
browse fill '#email' me@example.com
browse press '#password' Enter
browse wait 'text=Welcome'          # also an assertion: non-zero if it never shows
browse close                        # prints the mp4 path
```

Run one command, read the result, decide the next. The browser and the recording
start on the first command and stay alive between them.

## Install

Clone and install directly:

```sh
git clone https://github.com/ytkimirti/browse.git ~/browse
~/browse/bin/browse install
```

`install` puts `browse` on your PATH (`~/.local/bin`), links the clone in as an
agent skill for Claude Code (`~/.claude/skills`) and for anything that reads
`~/.agents/skills`, then downloads Playwright and a browser. Name directories to
link somewhere else instead, a project's own `./.agents/skills` say. Needs Node
18+, and re-running it is safe.

One clone is both the CLI and the skill, so `git pull` updates them together.
Playwright dependencies land in `~/.browse`; browser binaries go to Playwright's
shared cache, so one you already downloaded for another project is reused.

The repository also builds an installable npm package for macOS and Linux.
No registry publication is needed to install a local build:

```sh
npm pack --ignore-scripts --pack-destination /tmp
npm install -g /tmp/ytkimirti-browse-0.1.0.tgz
browse install
```

The package includes the CLI and agent skill. Installation runs no lifecycle
scripts and downloads no browser automatically; `browse install` links the skill
and performs setup. `browse help` and `browse version` work before setup.
Use `npm run test:package` to verify the packed file list and a fresh local install.
This package has not been published to the npm registry.

## Every session leaves

```
~/.browse/sessions/<when>/
  recording.mp4      cursor and keystrokes drawn in, dead air cut
  transcript.md      what was run, what came back
  shots/             a screenshot per step
  network.jsonl      requests, credentials redacted
```

## Record on a throwaway machine

A browser, a dev server and ffmpeg are the heaviest things an agent runs.
`browse box` moves all three onto a disposable [Upstash
Box](https://upstash.com/docs/box) and brings the mp4 back here. Two lines,
once:

```sh
browse box key      # prompts for a Box API key from console.upstash.com (starts with box_)
browse box up       # first run bakes a reusable image (~6 min); every one after is ~13s
```

`up` prints the host to pass as `--remote`, and `browse box help` shows a whole
session end to end. `browse box down` deletes it. Nothing is billed once the box
is gone, and the image that makes `up` fast costs cents a month.

## Delegate a task to TypeSafe

Give browse a goal. It observes the DOM, chooses and records an action, then
repeats until the goal is complete or a step/time limit is reached:

```sh
browse -s demo open https://example.com
browse -s demo ai task 'Click Learn more and stop once the Example Domains page is loaded.'
browse -s demo close
```

Set `TYPESAFE_API_KEY` or keep it in the caller's `.env`. `browse help` documents
task mode, individual semantic actions, assertions, scopes and limits. AI commands report
latency and tokens, decline uncertain matches and retain normal session evidence.
Tasks send the goal, visible controls, page text and action history to TypeSafe.
Text entry uses quoted strings from the goal or supplied named values. Exact selectors
remain the fastest, free option when you already know the target.

Run `node test/ai.test.mjs` and `node test/ai-task.test.mjs` for isolated browser
integration checks with a fake provider; set `BROWSE_ENGINE=camoufox` to verify that engine separately.
`node test/ai-boxes.mjs` prints the explicit opt-in for live tests on two disposable
Boxes, including real API calls, recordings, timings and teardown. Add `--task`
to exercise complete multistep goals.

## Beyond the basics

Stay logged in across sessions with a profile. Force an error path or an empty
list with request middleware. Freeze the clock before the app's JS runs.
Scope accessibility snapshots to a region, keep controls with compact output,
and use snapshot element references directly in actions. Deliberately opened
tabs join the recording while active; popup footage stays excluded until selected.
Existing Chromium browsers can be attached over CDP with explicit video opt-out,
keeping their tabs open when browse disconnects. See help for flags and limitations.

`browse help` lists every command and flag, `browse help --env` every env var.

MIT
