import psycopg2
import os

def get_db_connection():
    return psycopg2.connect(
        host=f"/cloudsql/{os.getenv('INSTANCE_CONNECTION_NAME')}",
        dbname=os.getenv("DB_NAME", "freefoodmap"),
        user=os.getenv("DB_USER", "ffm_user"),
        password=os.getenv("DB_PASSWORD"),
        port=int(os.getenv("DB_PORT", 5432))
    )