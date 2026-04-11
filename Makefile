.PHONY: test install-local

test:
	bun test

install-local:
	mkdir -p "$(HOME)/.local/bin"
	ln -sf "$(PWD)/src/index.ts" "$(HOME)/.local/bin/agent-threads"
	ln -sf "$(PWD)/src/index.ts" "$(HOME)/.local/bin/ath"
	chmod +x "$(PWD)/src/index.ts"
