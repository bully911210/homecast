# Contributing

Thanks for helping. The most useful things right now:

1. **TV reports.** Open a [TV report](../../issues/new?template=tv-report.yml) with your TV model and what worked or didn't. Remote keys, playback and pairing on real TVs are the least tested part.
2. **Providers.** A new source (IPTV `.m3u`, music, webcam, network share) is one file under `server/providers/` that implements `list()` and `open()`. If it needs a change to the core, the Item contract is wrong: say so in an issue first.
3. **Bugs** with steps to reproduce.

## The rule

Before adding anything, ask in order:

1. Can the platform already do it (the TV, Windows, Node built-ins, ffmpeg)?
2. Can something existing be reused?
3. Can the requirement be removed?

Only write new code if all three answers are no. New runtime dependencies need a one-line justification in `docs/DECISIONS.md`. The budget is 6 and it's full.

## Before a pull request

```bash
npm run typecheck
npm test
npm run e2e      # needs Google Chrome
```

Keep the TV client under 50 KB gzipped (`npm run build:client` prints the size) and its CSS and JS safe for Chrome 69.
