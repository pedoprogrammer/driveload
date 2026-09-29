import json
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
    def test_guest_extension_starts_without_account_or_api_key(self):
        public_address = [(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "",
                           ("93.184.216.34", 443))]
        app._guest_jobs.clear()
        with app.app.test_client() as client, \
             patch.object(app.socket, "getaddrinfo", return_value=public_address), \
             patch.object(app.threading, "Thread") as thread:
            response = client.post("/api/v1/guest/download", json={
                "url": "https://example.com/public-video"
            })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        thread.assert_called_once()

    def test_guest_extension_allows_repeated_completed_downloads(self):
        public_address = [(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "",
                           ("93.184.216.34", 443))]
        app._guest_jobs.clear()
        with app.app.test_client() as client, \
             patch.object(app.socket, "getaddrinfo", return_value=public_address), \
             patch.object(app.threading, "Thread"):
            for index in range(6):
                response = client.post("/api/v1/guest/download", json={
                    "url": f"https://example.com/public-video-{index}"
                })
                self.assertEqual(response.status_code, 200)
                app._guest_jobs[response.get_json()["job_id"]]["ready"] = True

    def test_guest_extension_limits_only_simultaneous_downloads(self):
        public_address = [(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "",
                           ("93.184.216.34", 443))]
        app._guest_jobs.clear()
        with app.app.test_client() as client, \
             patch.object(app.socket, "getaddrinfo", return_value=public_address), \
             patch.object(app.threading, "Thread"):
            first = client.post("/api/v1/guest/download", json={
                "url": "https://example.com/public-video-1"
            })
            second = client.post("/api/v1/guest/download", json={
                "url": "https://example.com/public-video-2"
            })
            third = client.post("/api/v1/guest/download", json={
                "url": "https://example.com/public-video-3"
            })

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(third.status_code, 429)
        self.assertIn("already running", third.get_json()["message"])

    def test_guest_extension_rejects_google_drive(self):
        with app.app.test_client() as client:
            response = client.post("/api/v1/guest/download", json={
                "url": "https://drive.google.com/file/d/example/view"
            })

        self.assertEqual(response.status_code, 400)
        self.assertIn("signed-in dashboard", response.get_json()["message"])

    def test_google_workspace_detection_is_host_specific(self):
        self.assertTrue(app.is_google_workspace_url(
            "https://drive.google.com/file/d/example/view"))
        self.assertFalse(app.is_google_workspace_url(
            "https://example.com/?next=drive.google.com"))

    def test_public_media_validation_rejects_private_hosts(self):
        address = [(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "",
                    ("127.0.0.1", 443))]
        with patch.object(app.socket, "getaddrinfo", return_value=address):
            with self.assertRaisesRegex(ValueError, "Private or local"):
                app.validate_public_media_url("https://internal.example/video")

    def test_public_media_download_returns_created_file(self):
        class FakeDownloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def extract_info(self, _url, download=True):
                output = self.options["outtmpl"].replace(
                    "%(title).180B", "sample").replace("%(id)s", "42").replace("%(ext)s", "mp4")
                with open(output, "wb") as handle:
                    handle.write(b"public-video")

        public_address = [(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "",
                           ("93.184.216.34", 443))]
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(app.socket, "getaddrinfo", return_value=public_address), \
             patch.object(app, "YoutubeDL", FakeDownloader):
            filename, path, size_mb = app.download_public_media(
                1, "https://example.com/video", directory)

        self.assertEqual(filename, "sample-42.mp4")
        self.assertGreater(size_mb, 0)
        self.assertTrue(path.endswith(filename))

    def test_youtube_download_uses_combined_stream_and_safari_fallback(self):
        captured = {}

        class FakeDownloader:
            def __init__(self, options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def extract_info(self, _url, download=True):
                output = captured["outtmpl"].replace(
                    "%(title).180B", "sample").replace("%(id)s", "42").replace(
                        "%(ext)s", "mp4")
                with open(output, "wb") as handle:
                    handle.write(b"public-video")

        public_address = [(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "",
                           ("142.250.186.110", 443))]
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(app.socket, "getaddrinfo", return_value=public_address), \
             patch.object(app, "YoutubeDL", FakeDownloader):
            app.download_public_media(
                1, "https://www.youtube.com/watch?v=rrFm3Npiabg", directory)

        self.assertEqual(captured["format"], "b[ext=mp4]/b/bv*+ba")
        self.assertEqual(
            captured["extractor_args"]["youtube"]["player_client"],
            ["default", "web_safari"])

    def test_video_info_uses_download_user_agent(self):
        metadata = FakeResponse()
        metadata.text = (
            "title=Training+Video&fmt_stream_map=37|"
            "https%3A%2F%2Fvideo.example.test%2Fvideoplayback"
        )
        probe = FakeResponse(status=206)

        with patch.object(app.http, "get", side_effect=[metadata, probe]) as get:
            video_url, title = app.get_video_info("file-id", {})

        self.assertEqual(video_url, "https://video.example.test/videoplayback")
        self.assertEqual(title, "Training Video")
        self.assertEqual(get.call_args_list[0].kwargs["headers"], app.GOOGLE_HEADERS)
        self.assertEqual(get.call_args_list[1].kwargs["headers"]["Range"], "bytes=0-0")

    def test_video_info_parser_supports_player_response(self):
        player = json.dumps({"streamingData": {"formats": [
            {"url": "https://video.example.test/videoplayback?id=1"}
        ]}})
        candidates, _ = app._parse_video_info(
            "player_response=" + app.quote(player)
        )
        self.assertEqual(candidates,
                         ["https://video.example.test/videoplayback?id=1"])

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
