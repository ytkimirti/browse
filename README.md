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

Not on npm yet, so clone it:

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
The npm package lands in `~/.browse`; the browser binaries go to Playwright's
shared cache, so one you already downloaded for another project is reused.

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

## Beyond the basics

Stay logged in across sessions with a profile. Force an error path or an empty
list with request middleware. Freeze the clock before the app's JS runs.

`browse help` lists every command and flag, `browse help --env` every env var.

MIT
