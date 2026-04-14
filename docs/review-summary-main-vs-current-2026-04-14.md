# Review Summary: Main vs Current Branch (2026-04-14)

This note summarizes the current state of `wip-ath-trigram-index` relative to `main`.

## Performance

On a shared static snapshot, the current branch is dramatically better on repeated warm reads:

- warm `inspect index`
- warm `recent`
- warm message search (`notify_url`, `payment`, `epay callback`)

Compared to `main`, the current branch still pays a higher cost on rebuild / cold-start:

- cold `inspect index`
- `admin reindex`

The broad conclusion is:

- steady-state local usage: current branch is much better
- rebuild-heavy workflows: `main` is still somewhat cheaper

## Result Quality

Relative to `main`, the current branch now has better message-result quality because it:

- removes same-thread duplication from top message hits
- boosts thread metadata hits (`title`, `first_user_message`)
- downranks broad-query meta discussion in natural-language searches

This makes the current branch substantially better for:

- code-ish token searches
- callback / config / identifier searches
- short developer phrase searches

Natural-language broad queries are improved, but still not at semantic-search quality.

## Practical Verdict

If the product goal is a better developer search tool for repeated local use, the current
branch is the stronger implementation.

If the primary priority is minimizing rebuild and cold-start latency above all else,
`main` still has an advantage there.

## Remaining Known Tradeoff

The branch is now in a reasonable place to commit as a first FTS-based implementation:

- warm path: win
- result quality: better
- cold path: improved, but not yet fully better than baseline/main
