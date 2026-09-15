import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { IngestPayload } from "./ingest-types.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const OBSERVATIONS = ["First planned memory", "Second planned memory"]
	.map(
		(title) =>
			`<observation><type>discovery</type><title>${title}</title><narrative>${title} body.</n+</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>`,
	)
	.join("");

function payload(): IngestPayload {
	return {
		cwd: "/tmp/test-project",
		events: [{ type: "user_prompt", prompt_text: "Persist both observations", prompt_number: 1 }],
	};
}

function observer() {
	return {
		observe: async () => ({
			raw: OBSERVATIONS,
			parsed: null,
			provider: "test",
			model: "test-model",
			usage: { inputTokens: 5, outputTokens: 7 },
		}),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};
}

describe("ingest persistence stages", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-ingest-stages-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rolls back planned memories and usage when a memory write fails", async () => {
		const remember = store.remember.bind(store);
		let calls = 0;
		vi.spyOn(store, "remember").mockImplementation((...args) => {
			calls += 1;
			if (calls === 2) throw new Error("planned write failed");
			return remember(...args);
		});

		await expect(
			ingest(payload(), store, {
				observer: observer(),
				storeSummary: false,
			} as unknown as IngestOptions),
		).rejects.toThrow("planned write failed");

		const memories = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
			count: number;
		};
		const usage = store.db.prepare("SELECT COUNT(*) AS count FROM usage_events").get() as {
			count: number;
		};
		expect(memories.count).toBe(0);
		expect(usage.count).toBe(0);
	});
});
