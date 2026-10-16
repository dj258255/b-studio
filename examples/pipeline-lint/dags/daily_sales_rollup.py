"""매일 판매 데이터를 모아 요약 테이블을 만드는 예시 DAG.

샌드박스에서는 실행하지 않는다. 게이트가 DagBag으로 이 파일을 import해 보고,
문법 오류·없는 모듈·잘못된 인자처럼 import 단계에서 드러나는 오류가 없는지만 확인한다.
"""

from datetime import datetime, timedelta

from airflow.providers.standard.operators.python import PythonOperator
from airflow.sdk import DAG


def extract(**_context):
    return [{"store": "a", "amount": 10}, {"store": "b", "amount": 5}]


def rollup(ti, **_context):
    rows = ti.xcom_pull(task_ids="extract")
    return sum(row["amount"] for row in rows)


with DAG(
    dag_id="daily_sales_rollup",
    schedule="0 2 * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
    tags=["example"],
) as dag:
    extract_task = PythonOperator(task_id="extract", python_callable=extract)
    rollup_task = PythonOperator(task_id="rollup", python_callable=rollup)

    extract_task >> rollup_task
