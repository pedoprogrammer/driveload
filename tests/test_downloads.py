import os
import tempfile
import unittest
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite:////tmp/driveload-tests.db"

import app


class FakeResponse:
    def __init__(self, body=b"", status=200, headers=None):
        self.body = body
        self.status_code = status
        self.headers = headers or {}

    def iter_content(self, _chunk_size):
        yield self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise app.http.HTTPError(str(self.status_code))

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class DownloadFileTests(unittest.TestCase):
    def test_worker_does_not_report_success_without_a_file(self):
        user_id = -999
        app._states.pop(user_id, None)

        with patch.object(app, "_broadcast") as broadcast:
            app._worker(user_id, [{"id": "missing", "url": ""}])

        result = broadcast.call_args_list[-1].args[1]
        self.assertTrue(result["done"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["ready_count"], 0)

    def test_stream_removes_file_only_after_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "video.mp4")
            with open(path, "wb") as handle:
                handle.write(b"video-data")

            stream = app._stream_then_remove(path, chunk_size=5)
            self.assertEqual(next(stream), b"video")
            self.assertTrue(os.path.exists(path))
            self.assertEqual(b"".join(stream), b"-data")
            self.assertFalse(os.path.exists(path))

    def test_range_ignored_streams_response_once(self):
        body = b"complete video"
        response = FakeResponse(body, headers={"Content-Length": str(len(body))})

        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "video.mp4")
            with patch.object(app.http, "get", return_value=response) as get:
                size_mb = app.download_file(1, "https://example.test/video", {}, output)

            self.assertEqual(get.call_count, 1)
            with open(output, "rb") as handle:
                self.assertEqual(handle.read(), body)
            self.assertEqual(size_mb, len(body) / 1048576)

    def test_valid_ranges_are_merged_in_order(self):
        size = 20 * 1048576
        probe = FakeResponse(
            b"x", status=206, headers={"Content-Range": f"bytes 0-0/{size}"}
        )

        def fake_chunk(_url, _cookies, start, end, part, tmpdir, retries=3):
            path = os.path.join(tmpdir, f"part_{part:04d}.tmp")
            data = bytes([part]) * (end - start + 1)
            with open(path, "wb") as handle:
                handle.write(data)
            return part, path, len(data)

        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "video.mp4")
            with patch.object(app.http, "get", return_value=probe), \
                 patch.object(app, "_dl_chunk", side_effect=fake_chunk) as chunks:
                app.download_file(1, "https://example.test/video", {}, output,
                                  threads=2, chunk_mb=8)

            self.assertEqual(chunks.call_count, 3)
            self.assertEqual(os.path.getsize(output), size)
            with open(output, "rb") as handle:
                self.assertEqual(handle.read(1), b"\x00")
                handle.seek(8 * 1048576)
                self.assertEqual(handle.read(1), b"\x01")


if __name__ == "__main__":
    unittest.main()
