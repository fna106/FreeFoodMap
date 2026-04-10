import psycopg2
import os

def get_db_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "136.114.68.152"),
        database=os.getenv("DB_NAME", "freefoodmap"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
        port=int(os.getenv("DB_PORT", 5432))
    )