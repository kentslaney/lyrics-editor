import pathlib
from urllib.request import urlretrieve

# mirror: https://github.com/smhanov/rhymeanalyzer
# stressed then unstressed counts
#     see: RhymeApp/src/backend/Stats.java:Stats.outStats
# last two entries represent the last two columns of consonants
#     see: RhymeApp/src/backend/Stats.java:Stats.align
sources = {
        "stats.txt": (
            "https://sourceforge.net/p/rhymeanalyzer/code/HEAD/tree/"
            "RhymeApp/src/backend/iterationStatsUF.txt?format=raw"),
        "altdict.txt": (
            "https://sourceforge.net/p/rhymeanalyzer/code/HEAD/tree/"
            "RhymeApp/src/backend/cmudict.txt?format=raw")
    }

dir = pathlib.Path(__file__).resolve().parent
for fname, url in sources.items():
    path = dir / fname
    if not path.exists():
        urlretrieve(url, path)
    with open(path) as fp:
        sources[fname] = fp.read()

stats_url = (
        "https://sourceforge.net/p/rhymeanalyzer/code/HEAD/tree/"
        "RhymeApp/src/backend/iterationStatsUF.txt?format=raw")
stats = sources["stats.txt"].replace("\r\n", "\n").split("\n\n")
stats = [[list(map(int, line.strip().split(' '))) if ' ' in line else int(line)
        for line in section.strip().split("\n")] for section in stats]
alt_lines = sources["altdict.txt"].strip().split("\n")
pronunciations = [i.split(' ', 1)[1].strip() for i in alt_lines]
stressless = [
        i.replace("0", "").replace("1", "").replace("2", "")
        for i in pronunciations]
flat = [j for i in stressless for j in i.split(' ')]
phonemes = sorted(set(flat))
print("\n".join(f"{repr(i)} {flat.count(i)}" for i in phonemes).strip())
print(stats[0], stats[4], sep="\n")
