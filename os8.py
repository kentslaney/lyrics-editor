import json, pathlib
import numpy as np

with open(pathlib.Path(__file__).parents[0] / "OS8-1.json") as fp:
    dat = json.load(fp)

arrs = ('vowels', 'consonants')
for fixing in arrs:
    inp, out = dat[fixing], []
    for i in range(len(inp)):
        out.append([])
        for j in range(len(inp[0])):
            if j >= i:
                out[-1].append(inp[i][j - i])
            else:
                out[-1].append(inp[j][i - j])
    dat[fixing] = out

vowels, consonants = (np.array(dat[i]) for i in arrs)
consonants_sq = consonants[:, :consonants.shape[0]]

#print(np.linalg.svd(vowels).S)
#print(np.linalg.svd(consonants_sq).S)
