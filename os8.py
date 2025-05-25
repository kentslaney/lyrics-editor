import json, pathlib
import numpy as np
import matplotlib.pyplot as plt

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

def diag(A): # https://math.stackexchange.com/a/1393907/1370602
    d = A.shape[0]
    j = np.ones(d)
    n = j.dot(A.dot(j.T))
    r = np.arange(d) + 1
    r2 = r ** 2
    Sx = r.dot(A.dot(j.T))
    Sy = j.dot(A.dot(r.T))
    Sx2 = r2.dot(A.dot(j.T))
    Sy2 = j.dot(A.dot(r2.T))
    Sxy = r.dot(A.dot(r.T))
    return (n * Sxy - Sx * Sy) / (
            ((n * Sx2 - Sx ** 2) ** 0.5) * ((n * Sy2 - Sy ** 2) ** 0.5))

def log_diag(A):
    return diag(np.exp(A))

def metropolis_hastings(A, it=1_000_000, f=log_diag, seed=0): # 6.437
    if seed is not None:
        np.random.seed(seed)
    d = A.shape[0]
    out = order = np.arange(d)
    best = score = f(A)
    for i in range(it):
        first, second = np.random.choice(d, 2, False)
        proposal = order[:]
        proposal[first], proposal[second] = proposal[second], proposal[first]
        shuffled = A[proposal, :][:, proposal]
        updated = f(shuffled)
        assert updated > 0
        accept = np.minimum(1, updated / score)
        if np.random.uniform() <= accept:
            order, score = proposal, updated
            if score > best:
                out, best = order, score
    return out, best

# consonants_order, _ = metropolis_hastings(consonants_sq, seed=1)
# vowels_order, _ = metropolis_hastings(vowels)
consonants_order = np.array([ # 0.9029487250951472
       10, 11,  8,  5,  2,  1, 19,  7,  4,  9, 17, 15, 14, 13,  0, 16, 18, 20,
       12,  3,  6])
vowels_order = np.array([ # 0.9556387333620513
    13,  9,  5,  4,  2,  6, 11,  1,  7, 12,  0, 10,  3, 14,  8])
consonants = consonants[consonants_order, :][:, consonants_order]
consonants_sq = consonants_sq[consonants_order, :][:, consonants_order]
vowels = vowels[vowels_order, :][:, vowels_order]

sym_filter = lambda x: [i for i, j in dat["symbols"] if dat["mapping"][j] == x]
vowels_sym, consonants_sym = sym_filter("vowels"), sym_filter("consonants")
sym_order = lambda x, y: [x[i] for i in y]
vowels_sym = sym_order(vowels_sym, vowels_order)
consonants_sym = sym_order(consonants_sym, consonants_order)

print(consonants_sym)
plt.imshow(consonants_sq)
plt.show()
