boot:
	customasm -q build/fructus.asm tangerine/monitor.s -f binary -o build/monitor.rom
	npm run microtan -- build/monitor.rom
