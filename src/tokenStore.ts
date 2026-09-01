import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredToken {
  identity: string;
  token: string;
  expiresAt: number;
  userId?: string;
}

/** Opaque key for the cached token so the file never holds the email. */
export function tokenIdentity(email: string, clientId: string): string {
  return createHash('sha256').update(`${email.trim().toLowerCase()}|${clientId}`).digest('hex');
}

export class TokenStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'token.json');
  }

  load(identity: string): StoredToken | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredToken>;
      if (
        raw.identity !== identity ||
        typeof raw.token !== 'string' ||
        typeof raw.expiresAt !== 'number' ||
        (raw.userId !== undefined && typeof raw.userId !== 'string')
      ) {
        return undefined;
      }
      return { identity: raw.identity, token: raw.token, expiresAt: raw.expiresAt, userId: raw.userId };
    } catch {
      return undefined;
    }
  }

  save(t: StoredToken): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    writeFileSync(this.file, JSON.stringify(t), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  clear(): void {
    if (existsSync(this.file)) {
      unlinkSync(this.file);
    }
  }
}
