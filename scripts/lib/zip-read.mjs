/**
 * 只读 ZIP 解析（IMP-003 §7.4 发布物校验用，`pnpm verify` 的取数底座）。
 *
 * 原来这里调的是 `execFileSync("unzip", ...)`：macOS 自带、多数 Linux 发行版装着，
 * 于是脚本在开发机上一直绿。Windows 上没有 `unzip`（10 以后自带的是 `tar`，
 * 形状完全不同），整条 verify 门禁在第一行就 ENOENT —— 而它判的是「这个包能不能发布」，
 * 恰恰是最需要在目标平台上跑的那一步。
 *
 * 自己读中央目录而不是引第三方库：vsix 就是一个 zip，需要的只有「列名字」和
 * 「取正文」两件事，node:zlib 的 inflateRawSync 已经够用。多一个依赖就多一份
 * NOTICES.md 里的分发义务，为两件事不值得。
 *
 * 范围与诚实边界：只支持普通（非 Zip64、非加密）条目，method 0/8。vsce 产出的包
 * 落在这个范围里；越界一律抛错而不是猜——静默读出错正文比报错难查得多。
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
/** EOCD 固定头 22 字节，尾部注释最长 65535 字节。 */
const EOCD_MAX_SCAN = 22 + 65535;
const ZIP64_SENTINEL = 0xffff_ffff;
/** 通用位标志第 11 位：条目名按 UTF-8 存。 */
const FLAG_UTF8_NAMES = 0x0800;
/** 通用位标志第 0 位：正文加密。 */
const FLAG_ENCRYPTED = 0x0001;

/** 从文件尾往前扫 EOCD 记录；不是 zip 就当场失败，不留到断言阶段报「缺条目」。 */
function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - EOCD_MAX_SCAN);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (readUInt32(buffer, offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error("不是有效的 ZIP 文件（找不到结束记录）");
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

/** 条目名解码：带 UTF-8 标志就直接解，否则按 CP437 家族的老写法走 latin1。 */
function decodeName(bytes, flags) {
  return bytes.toString(flags & FLAG_UTF8_NAMES ? "utf8" : "latin1");
}

/**
 * 打开一个 ZIP，返回条目名与取正文的函数。
 *
 * 中央目录一次解析完并缓存，`read(name)` 只按需解压——verify 要取七八个条目，
 * 全部预解压会把上百 KB 的 main.js 复制两份。
 */
export function openArchive(file) {
  const buffer = readFileSync(file);
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = readUInt32(buffer, eocd + 16);
  if (entryCount === 0xffff || centralOffset === ZIP64_SENTINEL) {
    throw new Error("Zip64 格式的包不在支持范围内（vsix 不应是这种）");
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, cursor) !== CENTRAL_ENTRY) {
      throw new Error(`中央目录第 ${index + 1} 条记录签名不对，包可能已损坏`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const uncompressedSize = readUInt32(buffer, cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = readUInt32(buffer, cursor + 42);
    const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new Error(`条目 ${name} 使用 Zip64 尺寸，不在支持范围内`);
    }
    // 同名条目以最后一条为准（zip 允许重复，追加写会覆盖读）。
    entries.set(name, { flags, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return {
    /** 全部条目名，含以 `/` 结尾的目录条目 —— 与 `unzip -Z1` 的输出同形。 */
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    /** 条目正文；不存在返回 null，交给调用方决定是「缺失」还是「读失败」。 */
    read(name) {
      const entry = entries.get(name);
      if (!entry) {
        return null;
      }
      if (entry.flags & FLAG_ENCRYPTED) {
        throw new Error(`条目 ${name} 是加密的，本读取器不解密`);
      }
      if (readUInt32(buffer, entry.localOffset) !== LOCAL_ENTRY) {
        throw new Error(`条目 ${name} 的本地头签名不对，包可能已损坏`);
      }
      // 尺寸与压缩法取中央目录那份：本地头在流式写入时可能是 0（配 data descriptor）。
      const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
      if (entry.method === 0) {
        return Buffer.from(raw);
      }
      if (entry.method === 8) {
        return inflateRawSync(raw);
      }
      throw new Error(`条目 ${name} 的压缩法 ${entry.method} 不在支持范围内`);
    }
  };
}
