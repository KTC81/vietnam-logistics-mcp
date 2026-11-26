/** Khai báo kiểu cho `scripts/quet-bi-mat.mjs` (script thuần JS, chạy bằng node). */
export interface SecretFile {
  path: string;
  content: string;
}

export interface SecretFinding {
  path: string;
  line: number;
  kind: string;
}

export interface ForbiddenTrackedName {
  path: string;
  reason: string;
}

export function findSecrets(files: SecretFile[]): SecretFinding[];
export function findForbiddenTrackedNames(paths: string[]): ForbiddenTrackedName[];
export function isProbablyBinary(buffer: Uint8Array): boolean;
export function collectTrackedNames(root?: string): string[];
export function collectTrackedFiles(root?: string): SecretFile[];
export function quetThuMuc(root: string): SecretFinding[];
