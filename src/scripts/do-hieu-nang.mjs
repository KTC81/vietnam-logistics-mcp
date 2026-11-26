#!/usr/bin/env node
/**
 * Đo hiệu năng 3 tool — chạy SAU `npm run build` vì dùng mã trong `dist/`.
 *
 *   node scripts/do-hieu-nang.mjs --mock          # T_noi_bo: cổng GHN giả, không mạng/token
 *   node scripts/do-hieu-nang.mjs                 # T_tool thật trên GHN staging (cần biến môi trường)
 *   npm run perf                                  # build rồi chạy chế độ thật
 *
 * Tham số: `--runs <n>` (mặc định 20, tối đa 1000), `--warmup <n>` (mặc định 2, tối đa 100),
 * `--out <đường dẫn>` (ghi báo cáo Markdown ra file; mặc định chỉ in màn hình), `--json`
 * (in thêm JSON thô), `--force` (cho phép ghi đè file báo cáo đã có sẵn).
 * KHÔNG ghi đè im lặng: đích đã tồn tại, là thư mục hoặc symlink thì từ chối (trừ file thường
 * khi có `--force`).
 *
 * Chế độ thật chỉ nhận `GHN_ENV=staging`; đọc token/ShopId/mã đơn từ biến môi trường, KHÔNG đọc
 * file .env và KHÔNG in giá trị nào của chúng. Chỉ số đạt dùng trung vị.
 *
 * Mã thoát: 0 = mọi tool có ngưỡng đều đạt; 2 = có tool không đạt; 1 = lỗi cấu hình/tham số
 * hoặc có lần gọi tool lỗi (KHÔNG HỢP LỆ).
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { platform, release } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  doLuong,
  ketLuanTool,
  kiemTraCauHinhThat,
  maLoiAnToan,
  phanTichThamSo,
  taoCongGhnGia,
  taoKeHoachDo,
  thongTinGiaMock,
  tinhMaThoat,
  xayDungBaoCao,
} from './hieu-nang-lib.mjs';

/** Logger rỗng: chế độ đo không ghi log (tránh nhiễu stdout và tránh lộ dữ liệu). */
const LOGGER_RONG = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/** Đọc name/version từ package.json (một nguồn, không hardcode). */
function docServerInfo() {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('package.json thiếu name/version');
  }
  return { name: parsed.name, version: parsed.version };
}

/** Mã commit ngắn để ghi báo cáo; không có git/repo thì "không rõ". */
function layCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'không rõ';
  }
}

/**
 * Kiểm đích ghi báo cáo TRƯỚC khi đo (khỏi phí thời gian). Trả thông báo lỗi tiếng Việt
 * hoặc `undefined` nếu được phép ghi. KHÔNG theo symlink; không ghi vào thư mục kể cả khi
 * có `--force`; file thường đã tồn tại chỉ ghi đè khi có `--force`.
 */
function kiemTraDichGhi(duongDan, force) {
  const dich = resolve(process.cwd(), duongDan);
  let thongTin;
  try {
    thongTin = lstatSync(dich);
  } catch {
    // Chưa có file (hoặc thư mục cha không tồn tại): để bước ghi báo lỗi rõ ràng.
    return undefined;
  }
  if (thongTin.isDirectory()) {
    return 'Đường dẫn báo cáo là thư mục, không ghi được.';
  }
  if (thongTin.isSymbolicLink()) {
    return 'Đường dẫn báo cáo là symlink, không ghi qua symlink.';
  }
  if (!force) {
    return 'File đã tồn tại. Thêm --force để ghi đè.';
  }
  return undefined;
}

/**
 * Nạp mã đã build. Trả lỗi tiếng Việt rõ ràng nếu chưa chạy `npm run build`
 * (không để lộ đường dẫn/stack của Node).
 */
async function napMaDaBuild() {
  try {
    const [serverMod, licenseMod, registryMod, detailMod, shopsMod, feeMod, envMod, ghnMod] =
      await Promise.all([
        import('../dist/server.js'),
        import('../dist/services/license-allow-all.js'),
        import('../dist/tools/registry.js'),
        import('../dist/tools/ghn/get-order-detail.js'),
        import('../dist/tools/ghn/get-shops.js'),
        import('../dist/tools/ghn/get-fee.js'),
        import('../dist/config/env.js'),
        import('../dist/services/ghn-client.js'),
      ]);
    return {
      createMcpServer: serverMod.createMcpServer,
      AllowAll: licenseMod.AllowAll,
      createToolRegistry: registryMod.createToolRegistry,
      getOrderDetailTool: detailMod.getOrderDetailTool,
      getShopsTool: shopsMod.getShopsTool,
      getFeeTool: feeMod.getFeeTool,
      loadConfig: envMod.loadConfig,
      EnvCredentialProvider: envMod.EnvCredentialProvider,
      createGhnClient: ghnMod.createGhnClient,
      serverInfo: docServerInfo(),
    };
  } catch {
    throw new Error('Chưa có mã đã build trong dist/. Chạy "npm run build" rồi thử lại.');
  }
}

/**
 * Gọi một tool qua MCP và chỉ trả dữ liệu an toàn cho phần thống kê: `tookMs` hoặc MÃ lỗi.
 * Không trả/không in thông báo lỗi hay dữ liệu thô.
 */
async function goiTool(client, ten, args) {
  let ketQua;
  try {
    ketQua = await client.callTool({ name: ten, arguments: args });
  } catch {
    return { ok: false, errorCode: 'INTERNAL_ERROR' };
  }

  const content = ketQua.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    return { ok: false, errorCode: 'INTERNAL_ERROR' };
  }

  let payload;
  try {
    payload = JSON.parse(first.text);
  } catch {
    return { ok: false, errorCode: 'INTERNAL_ERROR' };
  }

  if (payload?.ok === true && typeof payload?.meta?.tookMs === 'number') {
    return { ok: true, tookMs: payload.meta.tookMs };
  }
  const code = payload?.error?.code;
  return { ok: false, errorCode: typeof code === 'string' ? code : 'INTERNAL_ERROR' };
}

/** Dựng cổng GHN + credentials + kế hoạch đo theo chế độ; lỗi cấu hình trả về qua `loi`. */
function dungNguCanhDo(thamSo, env, ma) {
  if (thamSo.mode === 'mock') {
    return {
      credentials: {
        async getCredentials() {
          return {
            token: thongTinGiaMock.token,
            shopId: thongTinGiaMock.shopId,
            env: 'staging',
          };
        },
      },
      ghn: taoCongGhnGia(),
      keHoach: taoKeHoachDo({ mode: 'mock' }),
      nguCanhNhayCam: {
        token: thongTinGiaMock.token,
        shopId: thongTinGiaMock.shopId,
        orderCode: thongTinGiaMock.orderCode,
      },
    };
  }

  const kiemTra = kiemTraCauHinhThat(env);
  if (kiemTra.missing.length > 0) {
    return { loi: `Thiếu biến môi trường: ${kiemTra.missing.join(', ')}` };
  }
  if (kiemTra.error !== undefined) {
    return { loi: kiemTra.error };
  }

  let config;
  try {
    config = ma.loadConfig(env);
  } catch (error) {
    // messageVi của AppError chỉ nêu TÊN biến thiếu/sai định dạng, không nêu giá trị.
    const messageVi =
      error !== null && typeof error === 'object' && typeof error.messageVi === 'string'
        ? error.messageVi
        : 'Không đọc được cấu hình GHN. Kiểm tra biến môi trường rồi thử lại.';
    return { loi: messageVi };
  }

  const credentials = new ma.EnvCredentialProvider(config);
  return {
    credentials,
    ghn: ma.createGhnClient({ credentials }),
    keHoach: taoKeHoachDo({ mode: 'real', args: kiemTra.args }),
    nguCanhNhayCam: {
      token: env.GHN_TOKEN,
      shopId: config.shopId,
      orderCode: kiemTra.args.orderCode,
    },
  };
}

/**
 * Chạy đo và in báo cáo.
 * Không in token/ShopId/mã đơn/mã quận/phường; lỗi tool chỉ in MÃ lỗi.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let thamSo;
  try {
    thamSo = phanTichThamSo(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Tham số không hợp lệ.');
    return 1;
  }

  // Kiểm đích ghi NGAY sau khi phân tích tham số: từ chối sớm, không chạy đo vô ích.
  if (thamSo.out !== undefined) {
    const loiDich = kiemTraDichGhi(thamSo.out, thamSo.force);
    if (loiDich !== undefined) {
      console.error(loiDich);
      return 1;
    }
  }

  let ma;
  try {
    ma = await napMaDaBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Chưa có mã đã build.');
    return 1;
  }

  const nguCanhDo = dungNguCanhDo(thamSo, env, ma);
  if (nguCanhDo.loi !== undefined) {
    console.error(nguCanhDo.loi);
    return 1;
  }

  const registry = ma.createToolRegistry();
  registry.register(ma.getOrderDetailTool);
  registry.register(ma.getShopsTool);
  registry.register(ma.getFeeTool);

  const server = ma.createMcpServer({
    registry,
    credentials: nguCanhDo.credentials,
    ghn: nguCanhDo.ghn,
    license: new ma.AllowAll(),
    logger: LOGGER_RONG,
    serverInfo: ma.serverInfo,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'do-hieu-nang', version: '0.0.0' });
  await client.connect(clientTransport);

  let ketQuaDo;
  try {
    ketQuaDo = await doLuong({
      goi: (ten, args) => goiTool(client, ten, args),
      keHoach: nguCanhDo.keHoach,
      runs: thamSo.runs,
      warmup: thamSo.warmup,
    });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  const duLieuBaoCao = {
    mode: thamSo.mode,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    os: `${platform()} ${release()}`,
    commit: layCommit(),
    runs: thamSo.runs,
    warmup: thamSo.warmup,
    tools: ketQuaDo,
    // Trường nhạy cảm để test an toàn: báo cáo không dùng tới.
    nguCanhNhayCam: nguCanhDo.nguCanhNhayCam,
  };
  const baoCao = xayDungBaoCao(duLieuBaoCao);
  console.log(baoCao);

  if (thamSo.json) {
    // JSON thô: dựng khóa tường minh, KHÔNG bao giờ đưa `nguCanhNhayCam` vào.
    const congKhai = {
      mode: duLieuBaoCao.mode,
      generatedAt: duLieuBaoCao.generatedAt,
      nodeVersion: duLieuBaoCao.nodeVersion,
      os: duLieuBaoCao.os,
      commit: duLieuBaoCao.commit,
      runs: duLieuBaoCao.runs,
      warmup: duLieuBaoCao.warmup,
      tools: ketQuaDo.map((muc) => ({ ...muc, ketLuan: ketLuanTool(muc) })),
    };
    console.log(JSON.stringify(congKhai, null, 2));
  }

  if (thamSo.out !== undefined) {
    try {
      writeFileSync(resolve(process.cwd(), thamSo.out), `${baoCao}\n`, {
        encoding: 'utf8',
        // 'wx': tạo mới, KHÔNG ghi đè (đích đã kiểm trước ở kiemTraDichGhi).
        flag: thamSo.force ? 'w' : 'wx',
      });
    } catch {
      console.error(`Không ghi được báo cáo ra file: ${thamSo.out}`);
      return 1;
    }
  }

  return tinhMaThoat(ketQuaDo);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Chỉ in MÃ lỗi an toàn: không stack, không thông báo thô (có thể chứa dữ liệu nhạy cảm).
      console.error(`Không đo được (mã lỗi: ${maLoiAnToan(error)}).`);
      process.exitCode = 1;
    });
}
