import { expect, it } from "vitest";
import { configFrom } from "./config";
it("defaults to a read-only local workspace", () => {
  const c = configFrom({});
  expect(c.allowVaultWrites).toBe(false);
  expect(c.server.host).toBe("127.0.0.1");
});
it.each(["0.0.0.0", "::", "example.org"])("refuses bind address %s", (host) =>
  expect(() => configFrom({ server: { host } })).toThrow(/loopback/),
);
it("rejects writable application data inside the vault", () =>
  expect(() =>
    configFrom({ vaultPath: "/tmp/example", dataDir: "/tmp/example/state" }),
  ).toThrow(/separate/));
it("reserves built-in attachment roots and rejects duplicate root ids", () => {
  expect(() =>
    configFrom({
      attachments: { extraRoots: [{ id: "vault", path: "/tmp" }] },
    }),
  ).toThrow(/reserved ids/);
  expect(() =>
    configFrom({
      attachments: {
        extraRoots: [
          { id: "docs", path: "/tmp/a" },
          { id: "docs", path: "/tmp/b" },
        ],
      },
    }),
  ).toThrow(/unique/);
});
