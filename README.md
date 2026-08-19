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

```sh
npm i -g @ytkimirti/browse
browse setup
```

Node 18+. Playwright and a browser install themselves into `~/.browse` on first
use, or up front with `setup`.

## Install as an agent skill

```sh
ln -s "$(npm root -g)/@ytkimirti/browse" ~/.claude/skills/browse
```

Now an agent can reach for it by name. The skill teaches the loop, the artifacts
and the failure modes; `browse help` is the command surface.

## Every session leaves

```
~/.browse/sessions/<when>/
  recording.mp4      cursor and keystrokes drawn in, dead air cut
  transcript.md      what was run, what came back
  shots/             a screenshot per step
  network.jsonl      requests, credentials redacted
```

## Beyond the basics

Stay logged in across sessions with a profile. Force an error path or an empty
list with request middleware. Freeze the clock before the app's JS runs. Drive
the browser on another machine with `--remote`, or on a throwaway Upstash Box
with `browse-box`.

`browse help` lists every command and flag, `browse help --env` every env var.

MIT
