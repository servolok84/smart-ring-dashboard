# Contributing

## Adding support for another ring

The most useful contribution. If the app says *"doesn't expose a known ring
service"*, it prints the GATT services it found — that line identifies the
family.

1. Open an issue with that line, your ring's advertised name, and where you
   bought it.
2. If you want to implement it: `web/src/ble/` has one driver per family
   (`jring.ts`, `ring.ts` for Colmi). Both implement the same `RingLike`
   interface, and `connect.ts` picks between them by service UUID. A new family
   is a new file implementing that interface plus a branch in `connect.ts`.

The **packet log** in Settings shows every frame in hex, which is how the
existing drivers were verified. It's the right tool for this.

## Reporting a data bug

Include:

- Ring model and advertised name
- The relevant packet log lines (they contain no personal data — just hex)
- What you expected versus what appeared

## Code

```bash
cd web
npm install
npm run dev      # dev server
npx tsc -b       # type check
npm run build    # production build
```

**Demo mode** simulates a ring, so most UI work needs no hardware.

House style, loosely: comments explain *why*, not *what*; anything that reads
as a health judgement should be traceable to a documented rule (see
`scores.ts`); and the app should never imply medical authority it doesn't have.

## Protocol documentation

`docs/protocol.md` is meant to stand alone — useful to someone writing a client
in another language. If you decode something new, please document the packet
layout there, not only in code.
