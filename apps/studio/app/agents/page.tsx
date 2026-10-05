import { redirect } from 'next/navigation';

/** 예전 관제 주소. 작업 화면(/work)으로 합쳤다 — 저장해 둔 링크·알림이 깨지지 않게 넘긴다 */
export default function AgentsPage(): never {
  redirect('/work');
}
