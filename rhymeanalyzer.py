import requests

# stressed then unstressed counts
# mirror: https://github.com/smhanov/rhymeanalyzer
stats_url = (
        "https://sourceforge.net/p/rhymeanalyzer/code/HEAD/tree/"
        "RhymeApp/src/backend/iterationStatsUF.txt?format=raw")
stats = requests.get(stats_url).text.replace("\r\n", "\n").split("\n\n")
stats = [[list(map(int, line.strip().split(' '))) if ' ' in line else int(line)
        for line in section.strip().split("\n")] for section in stats]
alt_url = (
        "https://sourceforge.net/p/rhymeanalyzer/code/HEAD/tree/"
        "RhymeApp/src/backend/cmudict.txt?format=raw")
alt_lines = requests.get(alt_url).text.strip().split("\n")
pronunciations = [i.split(' ', 1)[1].strip() for i in alt_lines]
stressless = [
        i.replace("0", "").replace("1", "").replace("2", "")
        for i in pronunciations]
flat = [j for i in stressless for j in i.split(' ')]
phonemes = sorted(set(flat))
# print("\n".join(phonemes).strip())
print(stats[0], stats[4], sep="\n")
