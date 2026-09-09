#!/usr/bin/env python3
"""Draft a creator glossary from their own video titles.

The terms whisper mishears are the ones a creator says constantly: game modes,
server names, in-game items. Those same words dominate their titles, so the
back catalogue is a free first draft -- far better than starting from a blank
file and waiting to notice mistakes in finished videos.

Reads titles on stdin, one per line. Writes glossary lines to stdout, with the
Chinese side left blank for a human to fill in.
"""
import re
import sys
from collections import Counter

STOP = set("""
a an the and or but if then than that this these those with without within
i im ive id you your youre we our us they them their he she his her it its
is am are was were be been being do does did done doing have has had
to of in on at by for from into onto out up down over under off
my me mine so no not never all any some most more least best worst
what when where why how who which whom whose
i'm can't cant dont don't wont won't isnt isn't
video videos new full part episode ep vlog live stream streams
watch watching play playing played plays game games gaming
got get gets getting go goes going went
make makes made making try trying tried
insane crazy actually literally finally almost every first last
minute minutes hour hours day days week weeks year years
best worst funny epic ultimate real fake secret hidden
""".split())

WORD = re.compile(r"[A-Za-z][A-Za-z0-9'’]*")


def normalise(w: str) -> str:
    return w.replace("’", "'").strip("'").lower()


def main() -> None:
    titles = [t.strip() for t in sys.stdin if t.strip()]
    if not titles:
        sys.exit("no titles on stdin")

    unigrams: Counter[str] = Counter()
    bigrams: Counter[str] = Counter()
    display: dict[str, str] = {}

    for title in titles:
        words = WORD.findall(title)
        keys = []
        for w in words:
            k = normalise(w)
            keys.append(k)
            if len(k) < 4 or k in STOP:
                continue
            unigrams[k] += 1
            # Keep the creator's own casing -- HACKING and Hypixel are not the
            # same kind of word, and whisper benefits from the distinction.
            display.setdefault(k, w if not w.isupper() else w.title())

        for a, b in zip(keys, keys[1:]):
            if a in STOP or b in STOP or len(a) < 3 or len(b) < 3:
                continue
            bigrams[f"{a} {b}"] += 1

    # A phrase is only worth listing if it recurs; one-offs are title flavour.
    picked: list[str] = []
    for phrase, n in bigrams.most_common():
        if n < 3 or len(picked) >= 12:
            continue
        picked.append(" ".join(display.get(p, p).title() for p in phrase.split()))

    covered = {w.lower() for p in picked for w in p.split()}
    for word, n in unigrams.most_common():
        if n < 3 or word in covered or len(picked) >= 25:
            continue
        picked.append(display.get(word, word))

    print("# Drafted from video titles -- review before trusting it.")
    print("# Left side biases transcription. Add '=> 中文' to pin a translation.")
    print("# Delete anything that isn't a real name or piece of jargon.")
    print()
    for term in picked:
        print(term)


if __name__ == "__main__":
    main()
