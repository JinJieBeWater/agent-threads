.PHONY: test typecheck lint check install-local install-skill-local benchmark-baseline make-source-snapshot

test:
	bun test

typecheck:
	bun run typecheck

lint:
	bun run lint

check:
	bun run check

install-local:
	mkdir -p "$(HOME)/.local/bin"
	ln -sf "$(PWD)/src/index.ts" "$(HOME)/.local/bin/ath"
	chmod +x "$(PWD)/src/index.ts"

install-skill-local:
	mkdir -p "$(HOME)/.agents/skills"
	ln -sfn "$(PWD)/skills/agent-threads" "$(HOME)/.agents/skills/agent-threads"

benchmark-baseline:
	bun scripts/benchmark-baseline.ts

make-source-snapshot:
	bun scripts/make-source-snapshot.ts
