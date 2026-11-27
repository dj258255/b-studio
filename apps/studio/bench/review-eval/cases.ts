/**
 * 리뷰 평가 세트(결함을 심은 작은 diff들).
 *
 * 항목은 직접 쓴 코드 조각이다(저장소·모델 호출에 기대지 않는다). 결함 있는 항목 14개(TypeScript 7, Python 7, 결함 종류 8가지)와
 * 결함 없는 항목 4개(오탐 측정용)로 이뤄진다. 기대 지적의 줄은 결함이 든 줄의 글자(`defect`)로 찾아 diff의 새 파일 줄 번호로 바꾼다.
 *
 * 세트를 고치면 `EVAL_SET_VERSION`을 올린다. 결과 파일에는 세트 내용의 해시(evalSetHash)도 남아, 세트가 달라진 결과끼리는 비교하지 않는다.
 */
import { createHash } from 'node:crypto';
import { buildDiff, lineNumberOf } from './diff';
import type { DefectTag, EvalCase, EvalLanguage } from './types';

export const EVAL_SET_VERSION = 1;

interface Source {
  id: string;
  language: EvalLanguage;
  request: string;
  path: string;
  before?: string;
  after: string;
  /** 결함이 든 줄에 들어 있는 글자(새 파일에서 한 줄에만 있어야 한다)와 종류. 없으면 결함 없는 항목 */
  defects: Array<{ contains: string; tag: DefectTag; extraLines?: number }>;
}

const SOURCES: Source[] = [
  {
    id: 'ts-pagination-off-by-one',
    language: 'typescript',
    request: '목록 API에 쪽 나누기를 더해 주세요. page는 1부터 시작합니다.',
    path: 'src/pagination.ts',
    after: `/** page는 1부터 시작한다. 한 쪽에 size개씩 돌려준다 */
export function paginate<T>(items: readonly T[], page: number, size: number): T[] {
  if (page < 1 || size < 1) throw new RangeError('page와 size는 1 이상이어야 합니다');
  const start = page * size;
  return items.slice(start, start + size);
}
`,
    defects: [{ contains: 'const start = page * size;', tag: 'off-by-one' }],
  },
  {
    id: 'py-last-n-off-by-one',
    language: 'python',
    request: '로그에서 마지막 n줄만 돌려주는 함수를 더해 주세요.',
    path: 'logtail.py',
    after: `def last_n(lines, n):
    """lines의 마지막 n개를 순서대로 돌려준다. n이 0이면 빈 목록."""
    if n <= 0:
        return []
    return lines[len(lines) - n - 1:]
`,
    defects: [{ contains: 'return lines[len(lines) - n - 1:]', tag: 'off-by-one' }],
  },
  {
    id: 'ts-missing-user-null',
    language: 'typescript',
    request: '사용자 id로 이메일을 소문자로 돌려주세요. 없는 사용자면 null을 돌려줍니다.',
    path: 'src/user-email.ts',
    after: `interface User {
  id: string;
  email: string;
}

export function emailOf(users: Map<string, User>, id: string): string | null {
  const user = users.get(id);
  return user.email.toLowerCase();
}
`,
    defects: [{ contains: 'return user.email.toLowerCase();', tag: 'null-handling' }],
  },
  {
    id: 'py-optional-nickname-none',
    language: 'python',
    request: '프로필의 별명을 앞뒤 공백 없이 보여 주세요. 별명은 선택 항목입니다.',
    path: 'profile.py',
    after: `def display_name(profile):
    """별명이 있으면 별명, 없으면 이름을 돌려준다. 별명은 선택 항목이라 키가 없거나 None일 수 있다."""
    nickname = profile.get("nickname").strip()
    return nickname or profile["name"]
`,
    defects: [{ contains: 'profile.get("nickname").strip()', tag: 'null-handling' }],
  },
  {
    id: 'ts-sql-injection',
    language: 'typescript',
    request: '사용자의 주문을 상태별로 조회하는 함수를 더해 주세요.',
    path: 'src/orders-repo.ts',
    after: `import type { Pool } from 'pg';

export async function listOrders(pool: Pool, userId: string, status: string) {
  const sql = \`SELECT id, total, status FROM orders WHERE user_id = '\${userId}' AND status = '\${status}'\`;
  const result = await pool.query(sql);
  return result.rows;
}
`,
    defects: [{ contains: 'const sql = `SELECT', tag: 'sql-injection' }],
  },
  {
    id: 'py-command-injection',
    language: 'python',
    request: '업로드된 이미지를 PNG로 바꾸는 함수를 더해 주세요. 파일 이름은 사용자가 정합니다.',
    path: 'convert.py',
    after: `import subprocess


def to_png(filename):
    """업로드 폴더의 filename을 PNG로 바꾸고 결과 경로를 돌려준다."""
    out = filename + ".png"
    subprocess.run(f"convert uploads/{filename} uploads/{out}", shell=True, check=True)
    return out
`,
    defects: [{ contains: 'shell=True', tag: 'command-injection' }],
  },
  {
    id: 'ts-swallowed-charge-error',
    language: 'typescript',
    request: '주문을 결제하고 영수증 메일을 보내 주세요. 결제가 실패하면 호출한 쪽이 알아야 합니다.',
    path: 'src/checkout.ts',
    after: `import { charge, sendReceipt, markPaid } from './services';

export async function checkout(orderId: string, cardToken: string): Promise<void> {
  try {
    await charge(orderId, cardToken);
    await markPaid(orderId);
  } catch (error) {
    console.log('checkout failed');
  }
  await sendReceipt(orderId);
}
`,
    defects: [{ contains: "console.log('checkout failed');", tag: 'swallowed-error', extraLines: 0 }],
  },
  {
    id: 'py-swallowed-save-error',
    language: 'python',
    request: '결제 결과를 DB에 저장해 주세요. 저장이 실패하면 오류를 올려야 합니다.',
    path: 'payments.py',
    before: `def save_result(db, payment_id, status):
    db.execute("UPDATE payments SET status = %s WHERE id = %s", (status, payment_id))
    db.commit()
`,
    after: `def save_result(db, payment_id, status):
    try:
        db.execute("UPDATE payments SET status = %s WHERE id = %s", (status, payment_id))
        db.commit()
    except Exception:
        pass
`,
    defects: [{ contains: 'except Exception:', tag: 'swallowed-error', extraLines: 1 }],
  },
  {
    id: 'ts-age-boundary',
    language: 'typescript',
    request: '만 18세 이상만 가입할 수 있게 해 주세요.',
    path: 'src/signup.ts',
    before: `export function canSignUp(age: number): boolean {
  return Number.isInteger(age) && age >= 18;
}
`,
    after: `export function canSignUp(age: number): boolean {
  return Number.isInteger(age) && age > 18;
}
`,
    defects: [{ contains: 'age > 18', tag: 'boundary' }],
  },
  {
    id: 'py-average-empty',
    language: 'python',
    request: '주문 금액의 평균을 구해 리포트에 넣어 주세요. 주문이 없는 날도 리포트는 나와야 합니다.',
    path: 'report.py',
    after: `def average_order(amounts):
    """하루 주문 금액의 평균. 주문이 없는 날은 0을 돌려준다."""
    return sum(amounts) / len(amounts)


def daily_line(day, amounts):
    return f"{day}: {len(amounts)}건, 평균 {average_order(amounts):.0f}원"
`,
    defects: [{ contains: 'return sum(amounts) / len(amounts)', tag: 'boundary' }],
  },
  {
    id: 'ts-stock-race',
    language: 'typescript',
    request: '재고가 있을 때만 하나씩 차감해 주세요. 요청은 동시에 여러 개 들어옵니다.',
    path: 'src/stock.ts',
    after: `import { getStock, setStock } from './stock-store';

export async function reserveOne(productId: string): Promise<boolean> {
  const stock = await getStock(productId);
  if (stock <= 0) return false;
  await setStock(productId, stock - 1);
  return true;
}
`,
    defects: [{ contains: 'const stock = await getStock(productId);', tag: 'race-condition', extraLines: 2 }],
  },
  {
    id: 'py-balance-race',
    language: 'python',
    request: '잔액이 모자라지 않을 때만 출금하는 메서드를 더해 주세요. 여러 작업 스레드가 같은 계좌를 씁니다.',
    path: 'account.py',
    after: `class Account:
    """여러 작업 스레드가 같은 인스턴스를 공유한다."""

    def __init__(self, balance):
        self.balance = balance

    def withdraw(self, amount):
        if self.balance < amount:
            raise ValueError("잔액 부족")
        self.balance -= amount
        return self.balance
`,
    defects: [{ contains: 'if self.balance < amount:', tag: 'race-condition', extraLines: 2 }],
  },
  {
    id: 'ts-delete-project-no-authz',
    language: 'typescript',
    request: '프로젝트 삭제 API를 더해 주세요. 소유자만 지울 수 있어야 합니다.',
    path: 'src/routes/projects.ts',
    after: `import type { Request, Response } from 'express';
import { findProject, removeProject } from '../projects-store';

export async function deleteProject(req: Request, res: Response) {
  const project = await findProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  await removeProject(project.id);
  return res.status(204).end();
}
`,
    defects: [{ contains: 'export async function deleteProject', tag: 'missing-authz', extraLines: 5 }],
  },
  {
    id: 'py-invoice-no-authz',
    language: 'python',
    request: '청구서 조회 함수를 더해 주세요. 청구서는 그 주인만 볼 수 있습니다.',
    path: 'invoices.py',
    after: `def get_invoice(db, user, invoice_id):
    """invoice_id의 청구서를 돌려준다. 없으면 LookupError."""
    invoice = db.fetch_one("SELECT * FROM invoices WHERE id = %s", (invoice_id,))
    if invoice is None:
        raise LookupError(invoice_id)
    return invoice
`,
    defects: [{ contains: 'def get_invoice', tag: 'missing-authz', extraLines: 4 }],
  },
  {
    id: 'clean-ts-paginate',
    language: 'typescript',
    request: '목록 API에 쪽 나누기를 더해 주세요. page는 1부터 시작합니다.',
    path: 'src/pagination.ts',
    after: `/** page는 1부터 시작한다. 한 쪽에 size개씩 돌려준다 */
export function paginate<T>(items: readonly T[], page: number, size: number): T[] {
  if (!Number.isInteger(page) || !Number.isInteger(size) || page < 1 || size < 1) {
    throw new RangeError('page와 size는 1 이상의 정수여야 합니다');
  }
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
`,
    defects: [],
  },
  {
    id: 'clean-py-parameterized-query',
    language: 'python',
    request: '사용자의 주문을 상태별로 조회하는 함수를 더해 주세요.',
    path: 'orders_repo.py',
    after: `def list_orders(db, user_id, status):
    """user_id의 주문 중 status인 것을 최신순으로 돌려준다."""
    return db.fetch_all(
        "SELECT id, total, status FROM orders WHERE user_id = %s AND status = %s ORDER BY id DESC",
        (user_id, status),
    )
`,
    defects: [],
  },
  {
    id: 'clean-ts-checkout-rethrow',
    language: 'typescript',
    request: '주문을 결제하고 영수증 메일을 보내 주세요. 결제가 실패하면 호출한 쪽이 알아야 합니다.',
    path: 'src/checkout.ts',
    after: `import { charge, sendReceipt, markPaid } from './services';

export async function checkout(orderId: string, cardToken: string): Promise<void> {
  try {
    await charge(orderId, cardToken);
  } catch (error) {
    throw new Error(\`결제 실패(\${orderId})\`, { cause: error });
  }
  await markPaid(orderId);
  // 영수증은 결제 뒤의 부가 작업이라 실패해도 결제를 되돌리지 않고 기록만 남긴다
  await sendReceipt(orderId).catch((error: unknown) => console.error('영수증 전송 실패', orderId, error));
}
`,
    defects: [],
  },
  {
    id: 'clean-py-locked-withdraw',
    language: 'python',
    request: '잔액이 모자라지 않을 때만 출금하는 메서드를 더해 주세요. 여러 작업 스레드가 같은 계좌를 씁니다.',
    path: 'account.py',
    after: `import threading


class Account:
    """여러 작업 스레드가 같은 인스턴스를 공유한다."""

    def __init__(self, balance):
        self.balance = balance
        self._lock = threading.Lock()

    def withdraw(self, amount):
        with self._lock:
            if self.balance < amount:
                raise ValueError("잔액 부족")
            self.balance -= amount
            return self.balance
`,
    defects: [],
  },
];

function build(source: Source): EvalCase {
  const after = source.after.replace(/\n$/, '').split('\n');
  const before = source.before === undefined ? undefined : source.before.replace(/\n$/, '').split('\n');
  return {
    id: source.id,
    language: source.language,
    request: source.request,
    diff: buildDiff([{ path: source.path, ...(before ? { before } : {}), after }]),
    expected: source.defects.map((d) => {
      const startLine = lineNumberOf(after, d.contains);
      return { file: source.path, startLine, endLine: startLine + (d.extraLines ?? 0), tag: d.tag };
    }),
  };
}

export const EVAL_CASES: readonly EvalCase[] = SOURCES.map(build);

/** 세트 내용(항목 id·요청·diff·기대 지적)의 해시. 세트가 달라진 결과끼리 비교하지 않으려고 결과 파일에 남긴다 */
export function evalSetHash(cases: readonly EvalCase[] = EVAL_CASES): string {
  return createHash('sha256').update(JSON.stringify({ version: EVAL_SET_VERSION, cases })).digest('hex').slice(0, 16);
}
