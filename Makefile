.PHONY: test typecheck lint check install-local

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
