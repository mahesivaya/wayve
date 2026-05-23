import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changePassword,
  forgotPassword,
  login,
  register,
  resetPassword,
} from "../../api/Auth";

// Match whatever Vite picked up from .env so we don't hardcode a value.
const API_BASE = (import.meta.env.VITE_API_URL ?? "") as string;

const mockFetch = (status: number, body: unknown) => {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    clone() {
      return this;
    },
  };
  const fn = vi.fn().mockResolvedValue(response as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
};

describe("api/Auth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("register", () => {
    it("posts to /api/register and returns json", async () => {
      const fetchMock = mockFetch(200, { token: "abc" });
      const data = await register("a@b.c", "pw", "pw");
      expect(data).toEqual({ token: "abc" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_BASE}/api/register`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        email: "a@b.c",
        password: "pw",
        confirm_password: "pw",
        // Defaults to "full" inside the api/Auth.ts client when the
        // caller doesn't pass a value. Register.tsx supplies its own
        // (currently defaulting to "basic" — see that test).
        recovery_mode: "full",
      });
    });

    it("throws server message on non-2xx", async () => {
      mockFetch(400, { message: "User already exists" });
      await expect(register("a@b.c", "pw", "pw")).rejects.toThrow(
        "User already exists",
      );
    });
  });

  describe("login", () => {
    it("returns parsed token", async () => {
      mockFetch(200, { token: "jwt-xyz" });
      const data = await login("a@b.c", "pw");
      expect(data).toEqual({ token: "jwt-xyz" });
    });

    it("throws on non-2xx", async () => {
      mockFetch(401, { message: "bad" });
      await expect(login("a@b.c", "pw")).rejects.toThrow();
    });
  });

  describe("forgotPassword", () => {
    it("posts email to /api/forgot-password", async () => {
      const fetchMock = mockFetch(200, { message: "ok" });
      const data = await forgotPassword("a@b.c");
      expect(data).toEqual({ message: "ok" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_BASE}/api/forgot-password`);
      expect(JSON.parse(init.body)).toEqual({ email: "a@b.c" });
    });

    it("throws server message on failure", async () => {
      mockFetch(500, { message: "boom" });
      await expect(forgotPassword("a@b.c")).rejects.toThrow("boom");
    });
  });

  describe("resetPassword", () => {
    it("posts token + new_password", async () => {
      const fetchMock = mockFetch(200, { message: "ok" });
      await resetPassword("tok", "newpass1");
      const init = fetchMock.mock.calls[0][1];
      expect(JSON.parse(init.body)).toEqual({
        token: "tok",
        new_password: "newpass1",
      });
    });

    it("throws on invalid token", async () => {
      mockFetch(400, { message: "Invalid or expired link" });
      await expect(resetPassword("bad", "x")).rejects.toThrow(
        "Invalid or expired link",
      );
    });
  });

  describe("changePassword", () => {
    it("sends cookie credentials for authenticated requests", async () => {
      const fetchMock = mockFetch(200, { message: "ok" });
      await changePassword("old", "newpass1");
      const init = fetchMock.mock.calls[0][1];
      expect(init.credentials).toBe("include");
      expect(JSON.parse(init.body)).toEqual({
        current_password: "old",
        new_password: "newpass1",
      });
    });

    it("throws server message on non-2xx", async () => {
      localStorage.setItem("token", "x");
      mockFetch(401, { message: "Current password is incorrect" });
      await expect(changePassword("wrong", "newpass1")).rejects.toThrow(
        "Current password is incorrect",
      );
    });
  });
});
