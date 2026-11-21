"""Generates random segmenter cases from conformance/segmenter/reference.py (the oracle).

    python3 scripts/segmenter-fuzz.py <seed> <count>   # JSON on stdout

The alphabet mixes whitespace, terminators, closers, soft delimiters, abbreviations,
Devanagari with viramas and joiners, combining marks and astral characters. It avoids
characters assigned after Unicode 15.1, which runtimes classify differently (BEHAVIOR.md 7).
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "conformance" / "segmenter"))
import reference as R  # noqa: E402

ALPHABET = (
    list("0123456789") + ["."] * 6 + [" "] * 6
    + ["\t", "\n", "\n", "\r", "\x0b", "\x85", "\xa0", "　"]
    + list("DrMsetcNoAaBx") + ["Dr", "Mr", "etc", "No", "Inc"]
    + ["क", "ष", "र", "ड", "ॉ", "्", "्", "‍", "‌",
       "।", "॥", "ि", "́",
       "\U0001F600", "\U0001F44D\U0001F3FD", "\U0001D400", "\U0001D7CF", "\U00020000",
       "!", "?", "…", ",", ";", ":", "—", '"', ")", "”", "。", "！"]
)


def main() -> None:
    seed, count = int(sys.argv[1]), int(sys.argv[2])
    rng = random.Random(seed)
    cases = []
    for _ in range(count):
        text = "".join(rng.choice(ALPHABET) for _ in range(rng.choice([3, 8, 15, 30, 60, 120, 250])))
        opts = R.Options(
            min_chars=rng.randint(1, 30),
            first_min_chars=rng.randint(1, 10),
            max_chars=rng.choice([1, 2, 3, 5, 8, 13, 20, 40, 400]),
            eager_first_clause=rng.random() < 0.4,
            first_clause_min_chars=rng.randint(1, 30),
        )
        cases.append({"text": text, "options": opts.__dict__, "sentences": R.split_sentences(text, opts)})
    json.dump(cases, sys.stdout, ensure_ascii=True)


if __name__ == "__main__":
    main()
