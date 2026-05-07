import psycopg2
import os

def get_db_connection():
    instance_connection_name = os.getenv("INSTANCE_CONNECTION_NAME")
    host = f"/cloudsql/{instance_connection_name}" if instance_connection_name else os.getenv("DB_HOST", "localhost")

    return psycopg2.connect(
        host=host,
        dbname=os.getenv("DB_NAME", "freefoodmap"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
        port=int(os.getenv("DB_PORT", 5432))
    )
