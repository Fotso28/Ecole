"""Résume un relevé docker stats (CSV : horodatage,conteneur,CPU %,mémoire) : moyenne et maximum."""
import sys
from collections import defaultdict

UNITS = {'B': 1 / 2**20, 'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024}


def mib(value: str) -> float:
    value = value.strip()
    for unit in sorted(UNITS, key=len, reverse=True):
        if value.endswith(unit):
            return float(value[: -len(unit)]) * UNITS[unit]
    return 0.0


cpu, mem = defaultdict(list), defaultdict(list)
for line in open(sys.argv[1], encoding='utf-8'):
    parts = line.strip().split(',')
    if len(parts) != 4:
        continue
    _, name, c, m = parts
    if not name.startswith('ecole-'):
        continue
    cpu[name].append(float(c.rstrip('%') or 0))
    mem[name].append(mib(m.split('/')[0]))

print(f"\n{'Conteneur':<22}{'CPU moy.':>10}{'CPU max':>10}{'Mém. moy.':>12}{'Mém. max':>11}")
total_max = 0.0
for name in sorted(cpu):
    c, m = cpu[name], mem[name]
    total_max += max(m)
    print(f"{name:<22}{sum(c) / len(c):>9.0f}%{max(c):>9.0f}%{sum(m) / len(m):>9.0f} Mo{max(m):>8.0f} Mo")
print(f"{'Total (somme des max)':<52}{total_max:>21.0f} Mo")
