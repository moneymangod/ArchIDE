declare var globalThis: {
	process?: { env?: Record<string, string | undefined> };
	fetch?: typeof fetch;
};
