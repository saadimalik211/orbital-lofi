#!/usr/bin/env python3
"""Write the next MusicGen WAV for a world. Playback never runs this."""

import argparse
import json
import os
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROMPTS_PATH = ROOT / "src" / "worlds" / "musicPrompts.json"
MODEL_ID = "facebook/musicgen-small"
# Trained clip length for MusicGen-small. Longer single passes fall apart.
DURATION_S = 30
TOKENS_PER_SECOND = 50
GUIDANCE_SCALE = 3.0


def track_prefix(world_id: str) -> str:
    head = world_id.split("-", 1)[0]
    return f"{head}-ai"


def next_index(directory: Path, prefix: str) -> int:
    highest = 0
    if directory.is_dir():
        for path in directory.glob(f"{prefix}-*.wav"):
            number = path.stem.removeprefix(f"{prefix}-")
            if number.isdigit():
                highest = max(highest, int(number))
    return highest + 1


def load_prompts() -> dict[str, str]:
    raw = json.loads(PROMPTS_PATH.read_text())
    if not isinstance(raw, dict):
        raise SystemExit(f"expected an object in {PROMPTS_PATH}")
    prompts: dict[str, str] = {}
    for world_id, prompt in raw.items():
        if not isinstance(world_id, str) or not isinstance(prompt, str) or not prompt.strip():
            raise SystemExit(f"invalid prompt entry for {world_id!r}")
        prompts[world_id] = prompt
    return prompts


def destination(world_id: str, index: int) -> tuple[Path, str]:
    prefix = track_prefix(world_id)
    track_id = f"{prefix}-{index:02d}"
    path = ROOT / "public" / "worlds" / world_id / "music" / "ai" / f"{track_id}.wav"
    return path, track_id


def write_wav(path: Path, samples, sample_rate: int) -> None:
    import numpy as np

    audio = np.squeeze(np.asarray(samples, dtype=np.float32))
    if audio.ndim != 1:
        audio = audio.reshape(-1)
    if audio.size == 0 or not np.isfinite(audio).all():
        raise SystemExit("generation returned no usable samples")
    peak = float(np.max(np.abs(audio)))
    if peak <= 0:
        raise SystemExit("generation returned silence")
    pcm = np.clip(audio / peak * 0.89, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise SystemExit(f"refusing to overwrite {path}")
    partial = path.with_name(path.name + ".partial")
    with wave.open(str(partial), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    partial.replace(path)


def verify_wav(path: Path) -> float:
    if not path.is_file():
        raise SystemExit(f"missing output: {path}")
    size = path.stat().st_size
    with wave.open(str(path), "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
    if frames <= 0 or rate <= 0 or channels != 1 or width != 2 or size <= 44:
        raise SystemExit(f"invalid wav: {path}")
    duration = frames / float(rate)
    if duration <= 0:
        raise SystemExit(f"zero duration: {path}")
    print(f"file: {path.relative_to(ROOT)}")
    print(f"size: {size} bytes")
    print(f"duration: {duration:.2f}s")
    print(f"format: {rate} Hz, 16-bit mono")
    return duration


def print_config(world_id: str, track_id: str) -> None:
    src = f"/worlds/{world_id}/music/ai/{track_id}.wav"
    print("add to aiMusic:")
    print("{")
    print(f'  id: "{track_id}",')
    print(f'  src: "{src}"')
    print("}")


def pick_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def load_model(device: str):
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    cache = os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface"))
    print(f"model: {MODEL_ID}")
    print(f"cache: {cache}")
    print(f"device: {device}")
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
    try:
        model.to(device)
    except Exception as error:
        if device == "cpu":
            raise
        print(f"{device} unavailable ({error}); using cpu", file=sys.stderr)
        device = "cpu"
        model.to(device)
    model.eval()
    return model, processor, device, torch


def synthesize(model, processor, torch_module, prompt: str, device: str):
    inputs = processor(text=[prompt], padding=True, return_tensors="pt")
    inputs = {
        key: value.to(device) if hasattr(value, "to") else value
        for key, value in inputs.items()
    }
    tokens = DURATION_S * TOKENS_PER_SECOND
    print(f"generating up to {DURATION_S}s ({tokens} tokens) on {device}")
    try:
        with torch_module.inference_mode():
            audio = model.generate(
                **inputs,
                do_sample=True,
                guidance_scale=GUIDANCE_SCALE,
                max_new_tokens=tokens,
            )
    except Exception as error:
        if device == "cpu":
            raise SystemExit(f"generation failed: {error}") from error
        print(f"{device} generation failed ({error}); retrying on cpu", file=sys.stderr)
        model.to("cpu")
        return synthesize(model, processor, torch_module, prompt, "cpu")
    rate = int(model.config.audio_encoder.sampling_rate)
    samples = audio[0].detach().float().cpu().numpy()
    return samples, rate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the next AI track for a world.")
    parser.add_argument("world", help="World id, matching a key in src/worlds/musicPrompts.json")
    parser.add_argument("--count", type=int, default=1, help="How many new tracks to write")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.count < 1:
        raise SystemExit("--count must be at least 1")
    prompts = load_prompts()
    prompt = prompts.get(args.world)
    if prompt is None:
        known = ", ".join(sorted(prompts))
        raise SystemExit(f"unknown world '{args.world}'. Known worlds: {known}")

    directory = ROOT / "public" / "worlds" / args.world / "music" / "ai"
    start = next_index(directory, track_prefix(args.world))
    planned = [destination(args.world, start + offset) for offset in range(args.count)]
    for path, _track_id in planned:
        if path.exists():
            raise SystemExit(f"refusing to overwrite {path}")

    print(f"world: {args.world}")
    print(f"prompt: {prompt}")
    for path, _track_id in planned:
        print(f"writing: {path.relative_to(ROOT)}")
    model, processor, device, torch_module = load_model(pick_device())
    for path, track_id in planned:
        samples, rate = synthesize(model, processor, torch_module, prompt, device)
        write_wav(path, samples, rate)
        verify_wav(path)
        print_config(args.world, track_id)


if __name__ == "__main__":
    main()
