import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { ZipFile } from 'yazl';

export async function zipDirectory(sourceRoot: string): Promise<Buffer> {
  const files: Array<{ absolute: string; archivePath: string }> = [];

  async function collect(directory: string, relativeDirectory = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await collect(absolute, relative);
      } else if (entry.isFile()) {
        files.push({ absolute, archivePath: relative.replaceAll('\\', '/') });
      }
    }
  }

  await collect(sourceRoot);
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const file of files) {
      zip.addFile(file.absolute, file.archivePath);
    }
    zip.end();
  });
}
