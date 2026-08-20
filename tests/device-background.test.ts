import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceBackgroundError,
  MAX_BACKGROUND_BYTES,
  type StoredDeviceBackground,
  deleteDeviceBackground,
  getDeviceBackground,
  saveDeviceBackground,
  setDeviceBackgroundActive,
  subscribeDeviceBackground,
  validateDeviceBackgroundFile
} from "../src/device-background";

function createMemoryStorage() {
  let value: StoredDeviceBackground | null = null;
  return {
    get: vi.fn(async () => value),
    put: vi.fn(async (next: StoredDeviceBackground) => {
      value = next;
    }),
    delete: vi.fn(async () => {
      value = null;
    })
  };
}

const validFile = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("device background", () => {
  it("validates raster image type and original size", () => {
    expect(() => validateDeviceBackgroundFile(validFile())).not.toThrow();
    expect(() => validateDeviceBackgroundFile(new Blob(["not an image"], { type: "text/plain" }))).toThrowError(DeviceBackgroundError);

    const tooLarge = { size: MAX_BACKGROUND_BYTES + 1, type: "image/png", arrayBuffer: async () => new ArrayBuffer(0) } as Blob;
    expect(() => validateDeviceBackgroundFile(tooLarge)).toThrowError(/15 MB/);
  });

  it("saves, reads and deletes a compressed background without network access", async () => {
    const storage = createMemoryStorage();
    const compressed = {
      blob: new Blob(["webp bytes"], { type: "image/webp" }),
      mimeType: "image/webp" as const,
      width: 1920,
      height: 1080
    };
    const first = await saveDeviceBackground(validFile(), { storage, compress: async () => compressed });
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(first.mimeType).toBe("image/webp");
    expect(first.width).toBe(1920);

    const read = await getDeviceBackground({ storage });
    expect(read?.blob.size).toBe(compressed.blob.size);
    expect(read?.url === null || typeof read?.url === "string").toBe(true);

    await deleteDeviceBackground({ storage });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(await getDeviceBackground({ storage })).toBeNull();
  });

  it("notifies subscribers when the device background changes", async () => {
    const storage = createMemoryStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceBackground(listener);
    await saveDeviceBackground(validFile(), {
      storage,
      compress: async () => ({ blob: new Blob(["jpeg"], { type: "image/jpeg" }), mimeType: "image/jpeg", width: 1, height: 1 })
    });
    await deleteDeviceBackground({ storage });
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps one object URL when multiple subscribers read the same IndexedDB revision", async () => {
    const updatedAt = 987_654_321;
    const storage = {
      get: vi.fn(async () => ({
        key: "current" as const,
        blob: new Blob(["same image bytes"], { type: "image/webp" }),
        mimeType: "image/webp" as const,
        width: 1280,
        height: 720,
        active: true,
        updatedAt
      })),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    };
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:stable-background");

    const first = await getDeviceBackground({ storage });
    const callsAfterFirstRead = createUrl.mock.calls.length;
    const second = await getDeviceBackground({ storage });

    expect(second?.url).toBe(first?.url);
    expect(createUrl).toHaveBeenCalledTimes(callsAfterFirstRead);
  });

  it("can temporarily disable a stored picture without deleting it", async () => {
    const storage = createMemoryStorage();
    await saveDeviceBackground(validFile(), {
      storage,
      compress: async () => ({ blob: new Blob(["image"], { type: "image/webp" }), mimeType: "image/webp", width: 1600, height: 900 })
    });

    const disabled = await setDeviceBackgroundActive(false, { storage });
    expect(disabled?.active).toBe(false);
    expect(await storage.get()).not.toBeNull();

    const enabled = await setDeviceBackgroundActive(true, { storage });
    expect(enabled?.active).toBe(true);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("returns a safe error when storage is unavailable", async () => {
    const originalIndexedDb = (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
    try {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
      await expect(saveDeviceBackground(validFile(), { compress: async () => ({ blob: validFile(), mimeType: "image/webp", width: 1, height: 1 }) })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await expect(getDeviceBackground()).resolves.toBeNull();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb });
    }
  });

  it("maps storage failures without exposing image contents", async () => {
    const storage = {
      get: async () => null,
      put: async () => { throw new Error("disk full"); },
      delete: async () => undefined
    };
    await expect(saveDeviceBackground(validFile(), {
      storage,
      compress: async () => ({ blob: new Blob(["secret"], { type: "image/jpeg" }), mimeType: "image/jpeg", width: 1, height: 1 })
    })).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });
});
