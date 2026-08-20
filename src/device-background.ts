import { useCallback, useEffect, useState } from "react";

export const DEVICE_BACKGROUND_DB_NAME = "money-manager.device-background.v1";
export const DEVICE_BACKGROUND_STORE_NAME = "background";
export const DEVICE_BACKGROUND_KEY = "current";
export const DEVICE_BACKGROUND_DB_VERSION = 1;
export const MAX_BACKGROUND_BYTES = 15 * 1024 * 1024;
export const MAX_BACKGROUND_DIMENSION = 2560;

const allowedImageTypes = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export type DeviceBackgroundErrorCode =
  | "INVALID_TYPE"
  | "FILE_TOO_LARGE"
  | "COMPRESSION_UNSUPPORTED"
  | "COMPRESSION_FAILED"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_FAILED";

export class DeviceBackgroundError extends Error {
  readonly code: DeviceBackgroundErrorCode;

  constructor(code: DeviceBackgroundErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeviceBackgroundError";
    this.code = code;
  }
}

export interface StoredDeviceBackground {
  key: typeof DEVICE_BACKGROUND_KEY;
  blob: Blob;
  mimeType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
  active?: boolean;
  updatedAt: number;
}

export interface DeviceBackground {
  blob: Blob;
  url: string | null;
  mimeType: StoredDeviceBackground["mimeType"];
  width: number;
  height: number;
  active: boolean;
  updatedAt: number;
}

export interface CompressedDeviceBackground {
  blob: Blob;
  mimeType: StoredDeviceBackground["mimeType"];
  width: number;
  height: number;
}

export interface DeviceBackgroundStorage {
  get: () => Promise<StoredDeviceBackground | null>;
  put: (value: StoredDeviceBackground) => Promise<void>;
  delete: () => Promise<void>;
}

export interface DeviceBackgroundOptions {
  storage?: DeviceBackgroundStorage;
  compress?: (file: Blob) => Promise<CompressedDeviceBackground>;
}

export interface DeviceBackgroundState {
  background: DeviceBackground | null;
  isLoading: boolean;
  error: DeviceBackgroundError | null;
  refresh: () => Promise<DeviceBackground | null>;
  save: (file: Blob) => Promise<DeviceBackground>;
  activate: () => Promise<DeviceBackground | null>;
  deactivate: () => Promise<DeviceBackground | null>;
  remove: () => Promise<void>;
}

type DeviceBackgroundListener = () => void;

let activeView: DeviceBackground | null = null;
const listeners = new Set<DeviceBackgroundListener>();
let broadcastChannel: BroadcastChannel | null = null;
let broadcastInitialized = false;

function isBlobLike(value: Blob): value is Blob {
  return Boolean(value) && typeof value.size === "number" && typeof value.type === "string" && typeof value.arrayBuffer === "function";
}

function revokeActiveUrl(): void {
  if (!activeView?.url || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(activeView.url);
}

function createView(value: StoredDeviceBackground | null): DeviceBackground | null {
  if (!value) {
    revokeActiveUrl();
    activeView = null;
    return null;
  }
  // IndexedDB returns a new Blob object for every read. The timestamp identifies the
  // stored revision and prevents parallel React subscribers from revoking each
  // other's still-in-use object URL.
  if (activeView?.updatedAt === value.updatedAt) return activeView;
  revokeActiveUrl();
  const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(value.blob) : null;
  activeView = {
    blob: value.blob,
    url,
    mimeType: value.mimeType,
    width: value.width,
    height: value.height,
    active: value.active !== false,
    updatedAt: value.updatedAt
  };
  return activeView;
}

function notify(): void {
  for (const listener of listeners) listener();
  if (broadcastChannel) broadcastChannel.postMessage({ type: "changed" });
}

function initializeBroadcastChannel(): void {
  if (broadcastInitialized) return;
  broadcastInitialized = true;
  if (typeof BroadcastChannel !== "function") return;
  try {
    broadcastChannel = new BroadcastChannel(DEVICE_BACKGROUND_DB_NAME);
    broadcastChannel.addEventListener("message", () => {
      for (const listener of listeners) listener();
    });
  } catch {
    broadcastChannel = null;
  }
}

function getIndexedDbFactory(): IDBFactory | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const candidate = (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
  return candidate && typeof candidate.open === "function" ? candidate : undefined;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DEVICE_BACKGROUND_DB_NAME, DEVICE_BACKGROUND_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_BACKGROUND_STORE_NAME)) request.result.createObjectStore(DEVICE_BACKGROUND_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function indexedDbStorage(factory = getIndexedDbFactory()): DeviceBackgroundStorage | null {
  if (!factory) return null;
  return {
    get: async () => {
      const database = await openDatabase(factory);
      try {
        const transaction = database.transaction(DEVICE_BACKGROUND_STORE_NAME, "readonly");
        const result = await requestResult(transaction.objectStore(DEVICE_BACKGROUND_STORE_NAME).get(DEVICE_BACKGROUND_KEY));
        return (result as StoredDeviceBackground | undefined) ?? null;
      } finally {
        database.close();
      }
    },
    put: async (value) => {
      const database = await openDatabase(factory);
      try {
        const transaction = database.transaction(DEVICE_BACKGROUND_STORE_NAME, "readwrite");
        transaction.objectStore(DEVICE_BACKGROUND_STORE_NAME).put(value, DEVICE_BACKGROUND_KEY);
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    },
    delete: async () => {
      const database = await openDatabase(factory);
      try {
        const transaction = database.transaction(DEVICE_BACKGROUND_STORE_NAME, "readwrite");
        transaction.objectStore(DEVICE_BACKGROUND_STORE_NAME).delete(DEVICE_BACKGROUND_KEY);
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    }
  };
}

function requireStorage(storage?: DeviceBackgroundStorage): DeviceBackgroundStorage {
  const resolved = storage ?? indexedDbStorage();
  if (!resolved) throw new DeviceBackgroundError("STORAGE_UNAVAILABLE", "当前浏览器不支持设备背景存储");
  return resolved;
}

function toStorageError(error: unknown): DeviceBackgroundError {
  if (error instanceof DeviceBackgroundError) return error;
  return new DeviceBackgroundError("STORAGE_FAILED", "设备背景无法保存，请稍后重试", { cause: error });
}

export function validateDeviceBackgroundFile(file: Blob): void {
  if (!isBlobLike(file) || !allowedImageTypes.has(file.type.toLowerCase())) {
    throw new DeviceBackgroundError("INVALID_TYPE", "请选择 JPEG、PNG、WebP、GIF、AVIF 或 BMP 图片");
  }
  if (file.size > MAX_BACKGROUND_BYTES) {
    throw new DeviceBackgroundError("FILE_TOO_LARGE", "图片原文件不能超过 15 MB");
  }
}

function decodeWithImage(file: Blob): Promise<{ image: CanvasImageSource; width: number; height: number; close?: () => void }> {
  if (typeof document === "undefined" || typeof Image === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.reject(new DeviceBackgroundError("COMPRESSION_UNSUPPORTED", "当前环境无法压缩图片"));
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const sourceUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(sourceUrl);
      resolve({ image, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new DeviceBackgroundError("COMPRESSION_FAILED", "图片无法读取"));
    };
    image.src = sourceUrl;
  });
}

async function decodeImage(file: Blob): Promise<{ image: CanvasImageSource; width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to HTMLImageElement for browsers that cannot decode this format as a bitmap.
    }
  }
  return decodeWithImage(file);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: "image/webp" | "image/jpeg", quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === type) resolve(blob);
      else reject(new DeviceBackgroundError("COMPRESSION_FAILED", "图片压缩失败"));
    }, type, quality);
  });
}

export async function compressDeviceBackground(file: Blob): Promise<CompressedDeviceBackground> {
  validateDeviceBackgroundFile(file);
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    throw new DeviceBackgroundError("COMPRESSION_UNSUPPORTED", "当前环境无法压缩图片");
  }
  const decoded = await decodeImage(file);
  if (!decoded.width || !decoded.height) throw new DeviceBackgroundError("COMPRESSION_FAILED", "图片尺寸无效");
  const scale = Math.min(1, MAX_BACKGROUND_DIMENSION / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    decoded.close?.();
    throw new DeviceBackgroundError("COMPRESSION_UNSUPPORTED", "当前环境无法压缩图片");
  }
  try {
    context.drawImage(decoded.image, 0, 0, width, height);
    let blob: Blob;
    let mimeType: StoredDeviceBackground["mimeType"];
    try {
      blob = await canvasToBlob(canvas, "image/webp", 0.86);
      mimeType = "image/webp";
    } catch {
      blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
      mimeType = "image/jpeg";
    }
    return { blob, mimeType, width, height };
  } catch (error) {
    if (error instanceof DeviceBackgroundError) throw error;
    throw new DeviceBackgroundError("COMPRESSION_FAILED", "图片压缩失败", { cause: error });
  } finally {
    decoded.close?.();
  }
}

export async function getDeviceBackground(options: Pick<DeviceBackgroundOptions, "storage"> = {}): Promise<DeviceBackground | null> {
  initializeBroadcastChannel();
  let value: StoredDeviceBackground | null;
  try {
    value = await requireStorage(options.storage).get();
  } catch (error) {
    if (error instanceof DeviceBackgroundError && error.code === "STORAGE_UNAVAILABLE") return null;
    throw toStorageError(error);
  }
  return createView(value);
}

export async function saveDeviceBackground(file: Blob, options: DeviceBackgroundOptions = {}): Promise<DeviceBackground> {
  validateDeviceBackgroundFile(file);
  const storage = requireStorage(options.storage);
  let compressed: CompressedDeviceBackground;
  try {
    compressed = await (options.compress ?? compressDeviceBackground)(file);
    const value: StoredDeviceBackground = {
      key: DEVICE_BACKGROUND_KEY,
      blob: compressed.blob,
      mimeType: compressed.mimeType,
      width: compressed.width,
      height: compressed.height,
      active: true,
      updatedAt: Date.now()
    };
    await storage.put(value);
    const result = createView(value);
    if (!result) throw new DeviceBackgroundError("STORAGE_FAILED", "设备背景保存失败");
    notify();
    return result;
  } catch (error) {
    if (error instanceof DeviceBackgroundError && error.code !== "STORAGE_FAILED") throw error;
    throw toStorageError(error);
  }
}

export async function setDeviceBackgroundActive(active: boolean, options: Pick<DeviceBackgroundOptions, "storage"> = {}): Promise<DeviceBackground | null> {
  const storage = requireStorage(options.storage);
  try {
    const current = await storage.get();
    if (!current) return createView(null);
    const currentlyActive = current.active !== false;
    if (currentlyActive === active) return createView(current);
    const next: StoredDeviceBackground = { ...current, active, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
    await storage.put(next);
    const result = createView(next);
    notify();
    return result;
  } catch (error) {
    throw toStorageError(error);
  }
}

export async function deleteDeviceBackground(options: Pick<DeviceBackgroundOptions, "storage"> = {}): Promise<void> {
  try {
    await requireStorage(options.storage).delete();
  } catch (error) {
    throw toStorageError(error);
  }
  createView(null);
  notify();
}

export function subscribeDeviceBackground(listener: DeviceBackgroundListener): () => void {
  initializeBroadcastChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDeviceBackgroundStorageAvailable(): boolean {
  return Boolean(getIndexedDbFactory());
}

export function useDeviceBackground(): DeviceBackgroundState {
  const [background, setBackground] = useState<DeviceBackground | null>(null);
  const [isLoading, setIsLoading] = useState(() => typeof window !== "undefined");
  const [error, setError] = useState<DeviceBackgroundError | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await getDeviceBackground();
      setBackground(next);
      setError(null);
      return next;
    } catch (cause) {
      const nextError = toStorageError(cause);
      setError(nextError);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void refresh().then((next) => {
      if (mounted) setBackground(next);
    });
    const unsubscribe = subscribeDeviceBackground(() => {
      if (mounted) void refresh();
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [refresh]);

  const save = useCallback(async (file: Blob) => {
    setIsLoading(true);
    try {
      const next = await saveDeviceBackground(file);
      setBackground(next);
      setError(null);
      return next;
    } catch (cause) {
      const nextError = cause instanceof DeviceBackgroundError ? cause : toStorageError(cause);
      setError(nextError);
      throw nextError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setActive = useCallback(async (active: boolean) => {
    setIsLoading(true);
    try {
      const next = await setDeviceBackgroundActive(active);
      setBackground(next);
      setError(null);
      return next;
    } catch (cause) {
      const nextError = cause instanceof DeviceBackgroundError ? cause : toStorageError(cause);
      setError(nextError);
      throw nextError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const remove = useCallback(async () => {
    setIsLoading(true);
    try {
      await deleteDeviceBackground();
      setBackground(null);
      setError(null);
    } catch (cause) {
      const nextError = cause instanceof DeviceBackgroundError ? cause : toStorageError(cause);
      setError(nextError);
      throw nextError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const activate = useCallback(() => setActive(true), [setActive]);
  const deactivate = useCallback(() => setActive(false), [setActive]);

  return {
    background,
    isLoading,
    error,
    refresh,
    save,
    activate,
    deactivate,
    remove
  };
}
