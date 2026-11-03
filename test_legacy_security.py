"""Legacy security checks without connecting to PostgreSQL."""
import os
import sys
import unittest
import hashlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / ".legacy-test-deps"))
os.environ["APP_SECRET_KEY"] = "isolated-test-secret"
import main


class LegacySecurityTests(unittest.TestCase):
    def test_new_password_hash_and_legacy_compatibility(self):
        salt, value = main.sha1_hash("example-password")
        self.assertTrue(value.startswith(("scrypt:", "pbkdf2:")))
        self.assertTrue(main.verify_password(value, salt, "example-password"))
        self.assertFalse(main.verify_password(value, salt, "wrong-password"))
        old = hashlib.sha1(b"saltexample-password").hexdigest()
        self.assertTrue(main.verify_password(old, "salt", "example-password"))

    def test_mutations_require_post(self):
        client = main.app.test_client()
        self.assertEqual(client.get("/admin/locations/delete/1").status_code, 405)
        self.assertEqual(client.get("/admin/approve/1").status_code, 405)
        self.assertEqual(client.get("/logout").status_code, 405)

    def test_csrf_required(self):
        self.assertEqual(main.app.test_client().post("/login", data={}).status_code, 400)

    def test_templates_compile(self):
        for name in main.app.jinja_env.list_templates():
            main.app.jinja_env.get_template(name)


if __name__ == "__main__":
    unittest.main()
