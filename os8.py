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

def log_diag(inv_temp=1):
    def closure(A):
        return diag(np.exp(inv_temp * A))
    return closure

def metropolis_hastings(A, it=1_000_000, f=log_diag(), seed=0):
    if seed is not None:
        np.random.seed(seed)
    d = A.shape[0]
    out = order = np.arange(d)
    best = score = f(A)
    for i in range(it):
        first, second = np.random.choice(d, 2, False)
        proposal = np.copy(order)
        proposal[first], proposal[second] = proposal[second], proposal[first]
        shuffled = A[proposal, :][:, proposal]
        updated = f(shuffled)
        if updated > best:
            out, best = proposal, updated
        accept = 1 if updated > score else updated / score / d
        if np.random.uniform() <= accept:
            order, score = proposal, updated
    return out

# consonants_order = metropolis_hastings(consonants_sq)
# vowels_order = metropolis_hastings(vowels)
consonants_order = np.array([
        11, 17,  4,  1, 12,  7, 16, 10,  9, 13, 14,  3,  2, 18,  0,  5, 15,
        8, 19,  6, 20])
manual = [[16, 17], [0, 6], [11, 12], [10, 16], [11, 9]]
for first, second in manual:
    consonants_order[first], consonants_order[second] = \
            consonants_order[second], consonants_order[first]
vowels_order = np.array([
        12, 10,  8,  9,  6,  1,  2, 13,  3,  0,  7,  5, 11, 14,  4])
consonants = consonants[consonants_order, :][:, consonants_order]
consonants_sq = consonants_sq[consonants_order, :][:, consonants_order]
vowels = vowels[vowels_order, :][:, vowels_order]

sym_filter = lambda x: [i for i, j in dat["symbols"] if dat["mapping"][j] == x]
vowels_sym, consonants_sym = sym_filter("vowels"), sym_filter("consonants")
sym_order = lambda x, y: [x[i] for i in y]
vowels_sym = sym_order(vowels_sym, vowels_order)
consonants_sym = sym_order(consonants_sym, consonants_order)

print(
        log_diag()(consonants_sq), repr(consonants_order), consonants_sym,
        sep="\n", end="\n\n")
print(log_diag()(vowels), repr(vowels_order), vowels_sym, sep="\n")
plt.imshow(consonants_sq)
plt.show()
