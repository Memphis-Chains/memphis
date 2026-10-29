"""Exercise the CPU service without downloading or loading neural weights."""
import asyncio
import importlib.util
from pathlib import Path
import sys
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch


class HttpError(Exception):
    def __init__(self, status_code, detail, headers=None):
        self.status_code, self.detail, self.headers = status_code, detail, headers


class App:
    def get(self, _path):
        return lambda function: function
    post = get


def load_service():
    stubs = {
        "torch": types.SimpleNamespace(set_num_threads=lambda _count: None),
        "basal": types.ModuleType("basal"),
        "basal.engine": types.SimpleNamespace(EagerBackend=object),
        "basal.prompt": types.SimpleNamespace(render=Mock(), letter_ids=Mock(), MAX_OPTIONS=10),
        "fastapi": types.SimpleNamespace(FastAPI=App, HTTPException=HttpError, Request=object),
        "uvicorn": types.ModuleType("uvicorn"),
    }
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / "scripts/basal/basal_cpu.py"
    spec = importlib.util.spec_from_file_location("basal_cpu_under_test", source)
    service = importlib.util.module_from_spec(spec)
    # Only suppress the import-time loader. Inference threads below are real.
    with patch.dict(sys.modules, stubs), patch.object(threading.Thread, "start"):
        spec.loader.exec_module(service)
    return service


service = load_service()


def request(state="synthetic", orders=1, lang=None, typ="choice", criteria=None):
    return {"state": state, "orders": orders, "lang": lang,
            "questions": {"k": {"type": typ, "instructions": "Choose",
                                  "criteria": criteria or {"a": "Alpha", "b": "Beta"}}}}


class Request:
    def __init__(self, body):
        self.body = body
    async def json(self):
        return self.body


def reset():
    service._state.clear()
    service._state["eng"] = object()
    service._cache.clear()
    service.CACHE_ENTRIES = 2
    service.CACHE_TTL = 300
    service._pending_slots = threading.BoundedSemaphore(4)
    service._decide = Mock(return_value=[0.97, 0.03])


def infer(body):
    body = service._validate_request(body)
    eng = service._state["eng"]
    return service._infer_request(eng, body, service._cache_key(eng, body), time.monotonic())


class Contracts(unittest.TestCase):
    def setUp(self):
        reset()

    def test_boolean_label_matches_the_distribution_in_both_directions(self):
        for probs, label in [([0.97, 0.03], "a"), ([0.03, 0.97], "b")]:
            with self.subTest(label=label):
                service._cache.clear()
                service._decide.return_value = probs
                answer = infer(request(typ="noul"))["answers"]["k"]
                self.assertEqual(answer["noul"], label)
                self.assertEqual(answer["noul"], max(answer["probabilities"], key=answer["probabilities"].get))

    def test_choice_and_expected_ordinal_are_preserved(self):
        self.assertEqual(infer(request())["answers"]["k"]["choice"], "a")
        service._decide.return_value = [0.1, 0.2, 0.7]
        result = infer(request(typ="score", criteria={"0": "None", "1": "Partial", "2": "Complete"}))
        self.assertAlmostEqual(result["answers"]["k"]["score"], 1.6)

    def test_malformed_requests_are_rejected_before_inference(self):
        invalid = [None, [], {}, request(orders=0), request(orders=3), request(orders=True),
                   request(lang=5), request(typ="unknown"), request(criteria=["same", "same"]),
                   request(criteria={"one": "Only"}), request(criteria={str(i): str(i) for i in range(11)}),
                   request(typ="noul", criteria=["one", "two", "three"])]
        for change in [{"state": None}, {"questions": {}}, {"questions": {"k": None}},
                       {"questions": {"k": {"criteria": None}}},
                       {"questions": {"k": {"criteria": {"a": [], "b": "Beta"}}}}]:
            invalid.append({**request(), **change})
        for body in invalid:
            with self.subTest(body=body), self.assertRaises(HttpError) as caught:
                asyncio.run(service.systemone(Request(body)))
            self.assertEqual(caught.exception.status_code, 400)
        service._decide.assert_not_called()

    def test_all_questions_are_validated_before_computing_the_first(self):
        body = request()
        body["questions"]["bad"] = {"type": "noul", "criteria": ["one"]}
        with self.assertRaises(HttpError):
            asyncio.run(service.systemone(Request(body)))
        service._decide.assert_not_called()

    def test_identical_request_is_reused_and_cache_is_visible(self):
        first, second = infer(request()), infer(request())
        self.assertEqual(first["answers"], second["answers"])
        self.assertFalse(first["usage"]["cache_hit"])
        self.assertTrue(second["usage"]["cache_hit"])
        self.assertEqual(second["usage"]["inference_ms"], 0)
        self.assertEqual(service._decide.call_count, 1)

    def test_cache_does_not_mix_states_orders_languages_or_option_order(self):
        variants = [request(), request(state="changed"), request(orders=2), request(lang="pl"),
                    request(criteria={"b": "Beta", "a": "Alpha"})]
        for body in variants:
            self.assertFalse(infer(body)["usage"]["cache_hit"])
        self.assertEqual(service._decide.call_count, len(variants))

    def test_cache_does_not_reuse_another_engine(self):
        infer(request())
        old_engine = service._state["eng"]
        service._state["eng"] = object()
        self.assertFalse(infer(request())["usage"]["cache_hit"])
        self.assertIsNot(old_engine, service._state["eng"])

    def test_cache_values_are_independent_copies(self):
        infer(request())
        hit = infer(request())
        hit["answers"]["k"]["choice"] = "mutated"
        self.assertEqual(infer(request())["answers"]["k"]["choice"], "a")

    def test_expired_values_are_recomputed(self):
        infer(request())
        key = next(iter(service._cache))
        _, value = service._cache[key]
        service._cache[key] = -1, value
        self.assertFalse(infer(request())["usage"]["cache_hit"])
        self.assertEqual(service._decide.call_count, 2)

    def test_lru_cache_is_bounded(self):
        for state in ["one", "two", "one", "three"]:
            infer(request(state=state))
        self.assertEqual(len(service._cache), 2)
        self.assertFalse(infer(request(state="two"))["usage"]["cache_hit"])
        self.assertEqual(service._decide.call_count, 4)

    def test_cache_can_be_disabled(self):
        for entries, ttl in [(0, 300), (2, 0)]:
            service._cache.clear()
            service.CACHE_ENTRIES, service.CACHE_TTL = entries, ttl
            self.assertFalse(infer(request())["usage"]["cache_hit"])
            self.assertFalse(infer(request())["usage"]["cache_hit"])
            self.assertFalse(service._cache)

    def test_failed_inference_is_not_cached(self):
        service._decide.side_effect = RuntimeError("synthetic failure")
        with self.assertRaises(RuntimeError):
            infer(request())
        self.assertFalse(service._cache)
        self.assertFalse(service._state["inference_active"])


class Scheduling(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reset()
        self.entered, self.release = threading.Event(), threading.Event()
        def blocked(*_args, **_kwargs):
            self.entered.set()
            if not self.release.wait(3):
                raise RuntimeError("test release missing")
            return [0.97, 0.03]
        service._decide.side_effect = blocked

    async def asyncTearDown(self):
        self.release.set()

    async def test_health_stays_available_and_duplicate_requests_share_inference(self):
        first = asyncio.create_task(service.systemone(Request(request())))
        self.assertTrue(await asyncio.to_thread(self.entered.wait, 1))
        self.assertTrue(service.health()["ready"])
        self.assertTrue(service.health()["inference_active"])
        self.assertFalse(first.done())
        second = asyncio.create_task(service.systemone(Request(request())))
        await asyncio.sleep(0)
        self.release.set()
        a, b = await asyncio.gather(first, second)
        self.assertEqual(a["answers"], b["answers"])
        self.assertEqual(service._decide.call_count, 1)
        self.assertEqual(sorted([a["usage"]["cache_hit"], b["usage"]["cache_hit"]]), [False, True])

    async def test_full_queue_returns_503_without_another_model_call(self):
        tasks = [asyncio.create_task(service.systemone(Request(request(state=str(i))))) for i in range(4)]
        self.assertTrue(await asyncio.to_thread(self.entered.wait, 1))
        await asyncio.sleep(0)
        try:
            with self.assertRaises(HttpError) as caught:
                await service.systemone(Request(request(state="overflow")))
            self.assertEqual(caught.exception.status_code, 503)
            self.assertEqual(caught.exception.headers, {"Retry-After": "1"})
        finally:
            self.release.set()
            await asyncio.gather(*tasks)

    async def test_cancelled_client_retains_its_slot_until_the_model_finishes(self):
        task = asyncio.create_task(service.systemone(Request(request())))
        self.assertTrue(await asyncio.to_thread(self.entered.wait, 1))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        borrowed = 0
        while service._pending_slots.acquire(blocking=False):
            borrowed += 1
        self.assertEqual(borrowed, 3)
        for _ in range(borrowed):
            service._pending_slots.release()
        self.release.set()
        for _ in range(100):
            if not service._state.get("inference_active"):
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0)
        self.assertFalse(service._state["inference_active"])
        self.assertEqual(service._pending_slots._value, 4)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
