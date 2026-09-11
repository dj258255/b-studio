import type { ScriptedTurn } from '../scripted-client';

/**
 * examples/orders 프로젝트용 스크립트 시나리오.
 * API 키 없이 e2e 검증과 스튜디오 UI 시연에 같은 시나리오를 쓴다.
 * 모델의 코딩 능력이 아니라 루프·도구·검증 게이트·샌드박스가 맞물리는지를 보여 주는 용도다.
 */
export interface DemoScenario {
  id: 'orders-list' | 'order-memo' | 'drop-memo';
  title: string;
  request: string;
  allowBreaking?: boolean;
  maxVerifyAttempts?: number;
  turns: ScriptedTurn[];
  /** 이 요청을 보내기 전에 질문 모드로 물어볼 수 있는 준비된 질문 */
  question?: { request: string; turns: ScriptedTurn[] };
}

const MIGRATIONS = 'api/src/main/resources/db/migration';
const ORDERS_PKG = 'api/src/main/java/com/example/api/orders';

const ENTITY_WITH_TYPO = `package com.example.api.orders;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "orders")
public class CustomerOrder {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "customer_name", nullable = false, length = 100)
    private String customerName;

    protected CustomerOrder() {
    }

    public Long getId() {
        return id;
    }

    public String getCustomerName() {
        return customerNam;
    }
}
`;

const REPOSITORY = `package com.example.api.orders;

import org.springframework.data.jpa.repository.JpaRepository;

interface OrderRepository extends JpaRepository<CustomerOrder, Long> {
}
`;

const CONTROLLER = `package com.example.api.orders;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
class OrderController {

    private final OrderRepository orders;

    OrderController(OrderRepository orders) {
        this.orders = orders;
    }

    @GetMapping
    List<OrderResponse> list() {
        return orders.findAll().stream().map(OrderResponse::from).toList();
    }
}

record OrderResponse(Long id, String customerName) {

    static OrderResponse from(CustomerOrder order) {
        return new OrderResponse(order.getId(), order.getCustomerName());
    }
}
`;

const PAGE = `type Order = { id: number; customerName: string };

export default async function OrdersPage() {
  const response = await fetch(\`\${process.env.API_BASE_URL}/api/orders\`, { cache: "no-store" });
  const orders: Order[] = await response.json();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">주문</h1>
      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2">ID</th>
            <th className="py-2">고객</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="border-b">
              <td className="py-2">{order.id}</td>
              <td className="py-2">{order.customerName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
`;

const edit = (file: string, oldText: string, newText: string) => ({ name: 'edit_file', input: { path: file, old_text: oldText, new_text: newText } });
const write = (file: string, content: string) => ({ name: 'write_file', input: { path: file, content } });
const read = (file: string) => ({ name: 'read_file', input: { path: file } });
const list = (dir: string, depth: number) => ({ name: 'list_files', input: { path: dir, depth } });

const ORDERS_LIST_PLAN = `아직 주문 기능이 없습니다. api는 Spring Boot에 JPA·Flyway·PostgreSQL이 들어 있고, web은 Next.js 첫 화면(\`web/app/page.tsx\`)만 있습니다.

만들 때 바꿀 곳은 다음과 같습니다.

| 위치 | 변경 |
|---|---|
| \`${MIGRATIONS}/V1__create_orders.sql\` | 주문 테이블과 예시 데이터 |
| \`${ORDERS_PKG}/CustomerOrder.java\` | 주문 엔티티 |
| \`${ORDERS_PKG}/OrderRepository.java\` | 조회 저장소 |
| \`${ORDERS_PKG}/OrderController.java\` | \`GET /api/orders\` |
| \`web/app/orders/page.tsx\` | 서버에서 API를 불러 표로 보여 주는 주문 목록 화면 |

기존 API는 바꾸지 않으므로 계약 호환은 그대로입니다. 진행하려면 **이대로 만들기**를 누르세요.`;

const ORDER_MEMO_PLAN = `주문은 고객 이름만 가지고 있고, \`GET /api/orders\` 응답은 \`id\`와 \`customerName\`입니다.

| 위치 | 변경 |
|---|---|
| \`${MIGRATIONS}/V2__add_order_memo.sql\` | \`memo\` 열 추가 (이미 적용된 V1은 고치지 않음) |
| \`CustomerOrder.java\` | \`memo\` 필드와 getter |
| \`OrderController.java\` | 응답에 \`memo\` 추가 |
| \`web/app/orders/page.tsx\` | 배송 메모 열 |

응답에 필드를 더하기만 하므로 기존 화면과 호환됩니다. 진행하려면 **이대로 만들기**를 누르세요.`;

export const ORDERS_DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'orders-list',
    title: '주문 목록 API와 화면 (일부러 넣은 컴파일 에러를 게이트가 잡음)',
    request: '주문 목록 API와 화면을 만들어줘',
    question: {
      request: '주문 목록 화면을 만들려면 무엇을 바꿔야 해?',
      turns: [
        { text: '지금 구조부터 확인하겠습니다.', toolCalls: [list('.', 2), read('api/build.gradle'), read('web/app/page.tsx')] },
        { text: ORDERS_LIST_PLAN },
      ],
    },
    turns: [
      {
        text: '주문 테이블, 엔티티, 조회 API, 화면을 추가합니다.',
        toolCalls: [
          write(`${MIGRATIONS}/V1__create_orders.sql`, "create table orders (\n    id bigint generated by default as identity primary key,\n    customer_name varchar(100) not null\n);\n\ninsert into orders (customer_name) values ('김토스'), ('이스튜디오');\n"),
          write(`${ORDERS_PKG}/CustomerOrder.java`, ENTITY_WITH_TYPO),
          write(`${ORDERS_PKG}/OrderRepository.java`, REPOSITORY),
          write(`${ORDERS_PKG}/OrderController.java`, CONTROLLER),
          write('web/app/orders/page.tsx', PAGE),
        ],
      },
      { text: 'GET /api/orders와 /orders 화면을 추가했습니다.' },
      {
        text: '엔티티의 오타 때문에 컴파일에 실패했습니다. 고치겠습니다.',
        toolCalls: [edit(`${ORDERS_PKG}/CustomerOrder.java`, 'return customerNam;', 'return customerName;')],
      },
      { text: '오타로 인한 컴파일 에러를 고쳤습니다. GET /api/orders와 /orders 화면을 확인할 수 있습니다.' },
    ],
  },
  {
    id: 'order-memo',
    title: '배송 메모 필드 추가 (DB·API·화면 동시 변경, 호환 유지)',
    request: '주문에 배송 메모 필드 추가해줘',
    question: {
      request: '배송 메모를 넣으면 어디가 바뀌어?',
      turns: [
        {
          text: '지금 주문 코드와 API 계약을 확인하겠습니다.',
          toolCalls: [read(`${ORDERS_PKG}/CustomerOrder.java`), read(`${ORDERS_PKG}/OrderController.java`), { name: 'get_contract', input: { service: 'api' } }],
        },
        { text: ORDER_MEMO_PLAN },
      ],
    },
    turns: [
      {
        text: '마이그레이션, 엔티티, 응답, 화면에 배송 메모를 추가합니다.',
        toolCalls: [
          write(`${MIGRATIONS}/V2__add_order_memo.sql`, "alter table orders add column memo varchar(500);\n\nupdate orders set memo = '문 앞에 놓아주세요' where customer_name = '김토스';\n"),
          edit(`${ORDERS_PKG}/CustomerOrder.java`, '    private String customerName;\n', '    private String customerName;\n\n    @Column(length = 500)\n    private String memo;\n'),
          edit(`${ORDERS_PKG}/CustomerOrder.java`, '        return customerName;\n    }\n', '        return customerName;\n    }\n\n    public String getMemo() {\n        return memo;\n    }\n'),
          edit(`${ORDERS_PKG}/OrderController.java`, 'record OrderResponse(Long id, String customerName) {', 'record OrderResponse(Long id, String customerName, String memo) {'),
          edit(`${ORDERS_PKG}/OrderController.java`, 'order.getCustomerName());', 'order.getCustomerName(), order.getMemo());'),
          edit('web/app/orders/page.tsx', 'customerName: string };', 'customerName: string; memo: string | null };'),
          edit('web/app/orders/page.tsx', '            <th className="py-2">고객</th>\n', '            <th className="py-2">고객</th>\n            <th className="py-2">배송 메모</th>\n'),
          edit('web/app/orders/page.tsx', '              <td className="py-2">{order.customerName}</td>\n', '              <td className="py-2">{order.customerName}</td>\n              <td className="py-2">{order.memo ?? "-"}</td>\n'),
        ],
      },
      { text: 'V2 마이그레이션, 엔티티, 응답, 화면에 배송 메모를 추가했습니다.' },
    ],
  },
  {
    id: 'drop-memo',
    title: '요청하지 않은 필드 삭제 (게이트가 호환 깨짐으로 차단)',
    request: '주문 응답을 정리해줘',
    maxVerifyAttempts: 1,
    turns: [
      {
        text: '응답에서 쓰지 않는 필드를 정리합니다.',
        toolCalls: [
          edit(`${ORDERS_PKG}/OrderController.java`, 'record OrderResponse(Long id, String customerName, String memo) {', 'record OrderResponse(Long id, String customerName) {'),
          edit(`${ORDERS_PKG}/OrderController.java`, 'order.getCustomerName(), order.getMemo());', 'order.getCustomerName());'),
        ],
      },
      { text: '응답에서 쓰지 않는 필드를 정리했습니다.' },
    ],
  },
];
