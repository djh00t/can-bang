.PHONY: install check quality-gates clean build demo backup restore review

install:
	pnpm install --frozen-lockfile

check:
	pnpm --filter @can-bang/core build
	pnpm --filter @can-bang/core test
	pnpm --filter @can-bang/web build
	pnpm --filter @can-bang/web test
	pnpm typecheck
	pnpm format:check
	pnpm --filter @can-bang/server test
	@node -e 'const fs=require("node:fs");const html=fs.readFileSync("web/index.html","utf8");const m=/src="([^"]+)"/.exec(html);if(!m)throw new Error("no script src in index.html");const p="web"+m[1];if(!fs.existsSync(p))throw new Error("missing web asset: "+p);console.log("web asset ok:",p)'

quality-gates: check
	pnpm build

build:
	pnpm build

demo:
	bash demo/run-all.sh

backup:
	pnpm --filter @can-bang/server exec node scripts/backup.mjs

restore:
	pnpm --filter @can-bang/server exec node scripts/restore.mjs $(BACKUP)

review:
	node scripts/review.mjs

clean:
	rm -rf node_modules */node_modules */dist coverage
