/**
 * AirGases.js - the air and its gases from 100 to 900 km at three Sun levels (plan sky-air-1121, DECISIONS §80 rows 2-3).
 *
 * Data: ECSS-E-ST-10-04C Annex G tables G-1..G-3, NRLMSISE-00 atmosphere (day/night and season mean, equatorial), read through
 * the web reader on 2026-11-20 from SPENVIS:
 *   low  (F10.7 65,  Ap 0)  https://www.spenvis.oma.be/ecss/e_st_10_04c/ecss_18_09_01.htm  (Table G-1)
 *   mean (F10.7 140, Ap 15) https://www.spenvis.oma.be/ecss/e_st_10_04c/ecss_18_09_02.htm  (Table G-2)
 *   high (F10.7 250, Ap 45) https://www.spenvis.oma.be/ecss/e_st_10_04c/ecss_18_09_03.htm  (Table G-3)
 * Columns as printed: H (km), nHE, nO, nN2, nO2, nAR, nH, nN, nAnomal O (all m^-3), T (K), rho (kg/m3); rows every 20 km.
 * The pages print decimals with commas ("1,17E+20"); the rows below keep that text and `parseRow` reads it. 41 rows each, 100-900 km.
 * The 900 km density of the high table prints 6,00E-14, which looks like a misprint (only 4 % under the 880 km row, while the
 * steps above are 17-20 %; 12.9 % off the row's own gases). `rho` keeps the printed number, but the chart draws `rhoUsed`, the sum
 * of the gases of that row (5.23E-14), for that one row (see `SOURCE_MISPRINTS`). The game's own air (SunStorms.js) holds the
 * 880 km ratio above that height.
 *
 * What is modelled: the page says so on screen ("Modelled, fitted to satellite data"). Nothing is fetched at run time.
 *
 * "Today's" level is read between the three tables the way `SunStorms.sunMultiplier` does it: ln density linear in F10.7 between
 * 65 / 140 / 250, held outside that range, and linear in height between rows (in ln density). This file MIRRORS that rule (it does
 * not import SunStorms, which pulls in the game state); a test checks the two agree to 1e-9 on the whole-air density.
 *
 * Pure module: no DOM, no game state.
 *
 * @module systems/AirGases
 */

/** Sun levels of the three tables (F10.7, solar flux units). */
export const F107_LOW = 65;
export const F107_MOD = 140;
export const F107_HIGH = 250;
/** Table keys in order, quiet to busy. */
export const LEVELS = ['low', 'mean', 'high'];
/** F10.7 of each table key. */
export const LEVEL_F107 = { low: F107_LOW, mean: F107_MOD, high: F107_HIGH };
/** First row, last row, step (km). */
export const ROW0_KM = 100;
export const ROW_TOP_KM = 900;
export const ROW_STEP_KM = 20;
export const ROW_COUNT = 41;

/** Avogadro's number, 1/mol (CODATA 2018 exact). */
export const AVOGADRO = 6.02214076e23;

/**
 * The gases of the tables: key (the row field), plain-word label, molar mass in g/mol (standard atomic weights).
 * Anomalous oxygen is atomic oxygen too (it is kept in the sum, not drawn on its own).
 */
export const GASES = [
  { key: 'nHe', label: 'Helium', molarMass: 4.0026 },
  { key: 'nO', label: 'Oxygen atoms', molarMass: 15.999 },
  { key: 'nN2', label: 'Nitrogen', molarMass: 28.0134 },
  { key: 'nO2', label: 'Oxygen molecules', molarMass: 31.998 },
  { key: 'nAr', label: 'Argon', molarMass: 39.948 },
  { key: 'nH', label: 'Hydrogen', molarMass: 1.00794 },
  { key: 'nN', label: 'Nitrogen atoms', molarMass: 14.0067 },
  { key: 'nOanom', label: 'Anomalous oxygen', molarMass: 15.999 },
];

const RAW_LOW = [
  '100|1,17E+14|4,78E+17|1,02E+19|2,38E+18|1,04E+17|2,70E+13|3,10E+11|2,24E-37|1,71E+02|6,18E-07',
  '120|2,50E+13|7,23E+16|3,11E+17|4,36E+16|1,36E+15|6,07E+12|1,19E+12|1,41E-27|3,53E+02|1,88E-08',
  '140|1,50E+13|2,12E+16|4,89E+16|4,45E+15|1,09E+14|2,17E+12|6,16E+12|2,44E-19|5,21E+02|3,08E-09',
  '160|1,16E+13|9,37E+15|1,38E+16|1,06E+15|1,88E+13|1,09E+12|1,61E+13|1,12E-12|6,05E+02|9,49E-10',
  '180|9,61E+12|4,88E+15|4,76E+15|3,34E+14|4,23E+12|7,31E+11|2,20E+13|1,45E-07|6,48E+02|3,70E-10',
  '200|8,21E+12|2,73E+15|1,80E+15|1,15E+14|1,08E+12|5,94E+11|2,02E+13|1,20E-03|6,70E+02|1,63E-10',
  '220|7,12E+12|1,59E+15|7,14E+14|4,11E+13|2,98E+11|5,32E+11|1,51E+13|1,22E+00|6,82E+02|7,80E-11',
  '240|6,21E+12|9,42E+14|2,93E+14|1,51E+13|8,62E+10|4,98E+11|1,04E+13|2,43E+02|6,88E+02|3,97E-11',
  '260|5,45E+12|5,66E+14|1,23E+14|5,66E+12|2,59E+10|4,75E+11|6,85E+12|1,40E+04|6,92E+02|2,13E-11',
  '280|4,78E+12|3,44E+14|5,27E+13|2,16E+12|8,02E+09|4,57E+11|4,50E+12|3,08E+05|6,94E+02|1,18E-11',
  '300|4,21E+12|2,10E+14|2,30E+13|8,42E+11|2,54E+09|4,41E+11|2,96E+12|3,26E+06|6,95E+02|6,80E-12',
  '320|3,71E+12|1,30E+14|1,01E+13|3,33E+11|8,22E+08|4,27E+11|1,96E+12|1,96E+07|6,96E+02|4,01E-12',
  '340|3,28E+12|8,05E+13|4,54E+12|1,33E+11|2,71E+08|4,13E+11|1,30E+12|7,64E+07|6,96E+02|2,41E-12',
  '360|2,90E+12|5,02E+13|2,06E+12|5,42E+10|9,06E+07|4,00E+11|8,74E+11|2,13E+08|6,96E+02|1,47E-12',
  '380|2,56E+12|3,15E+13|9,43E+11|2,23E+10|3,07E+07|3,87E+11|5,88E+11|4,60E+08|6,96E+02|9,14E-13',
  '400|2,27E+12|1,99E+13|4,37E+11|9,29E+09|1,06E+07|3,75E+11|3,98E+11|8,15E+08|6,96E+02|5,75E-13',
  '420|2,01E+12|1,26E+13|2,04E+11|3,91E+09|3,66E+06|3,64E+11|2,70E+11|1,24E+09|6,96E+02|3,66E-13',
  '440|1,78E+12|8,06E+12|9,61E+10|1,66E+09|1,29E+06|3,53E+11|1,85E+11|1,69E+09|6,96E+02|2,35E-13',
  '460|1,58E+12|5,17E+12|4,56E+10|7,13E+08|4,55E+05|3,42E+11|1,26E+11|2,09E+09|6,96E+02|1,53E-13',
  '480|1,41E+12|3,33E+12|2,18E+10|3,09E+08|1,63E+05|3,32E+11|8,68E+10|2,42E+09|6,96E+02|1,01E-13',
  '500|1,25E+12|2,15E+12|1,05E+10|1,35E+08|5,87E+04|3,22E+11|5,99E+10|2,66E+09|6,96E+02|6,79E-14',
  '520|1,11E+12|1,40E+12|5,11E+09|5,92E+07|2,13E+04|3,12E+11|4,15E+10|2,81E+09|6,96E+02|4,63E-14',
  '540|9,91E+11|9,14E+11|2,50E+09|2,62E+07|7,81E+03|3,03E+11|2,88E+10|2,88E+09|6,96E+02|3,21E-14',
  '560|8,83E+11|5,99E+11|1,23E+09|1,17E+07|2,88E+03|2,94E+11|2,00E+10|2,88E+09|6,96E+02|2,28E-14',
  '580|7,88E+11|3,94E+11|6,07E+08|5,24E+06|1,07E+03|2,85E+11|1,40E+10|2,83E+09|6,96E+02|1,65E-14',
  '600|7,04E+11|2,60E+11|3,02E+08|2,36E+06|4,01E+02|2,77E+11|9,79E+09|2,74E+09|6,96E+02|1,23E-14',
  '620|6,29E+11|1,73E+11|1,51E+08|1,07E+06|1,51E+02|2,69E+11|6,88E+09|2,63E+09|6,96E+02|9,37E-15',
  '640|5,63E+11|1,15E+11|7,59E+07|4,90E+05|5,74E+01|2,61E+11|4,84E+09|2,50E+09|6,96E+02|7,33E-15',
  '660|5,04E+11|7,67E+10|3,84E+07|2,25E+05|2,19E+01|2,54E+11|3,42E+09|2,37E+09|6,96E+02|5,88E-15',
  '680|4,51E+11|5,14E+10|1,95E+07|1,04E+05|8,42E+00|2,46E+11|2,42E+09|2,23E+09|6,96E+02|4,83E-15',
  '700|4,04E+11|3,45E+10|9,94E+06|4,84E+04|3,26E+00|2,39E+11|1,72E+09|2,09E+09|6,96E+02|4,04E-15',
  '720|3,63E+11|2,33E+10|5,10E+06|2,26E+04|1,27E+00|2,33E+11|1,22E+09|1,96E+09|6,96E+02|3,44E-15',
  '740|3,26E+11|1,58E+10|2,63E+06|1,06E+04|4,97E-01|2,26E+11|8,70E+08|1,83E+09|6,96E+02|2,98E-15',
  '760|2,93E+11|1,07E+10|1,36E+06|5,00E+03|1,96E-01|2,20E+11|6,21E+08|1,70E+09|6,96E+02|2,61E-15',
  '780|2,63E+11|7,28E+09|7,06E+05|2,37E+03|7,75E-02|2,14E+11|4,45E+08|1,59E+09|6,96E+02|2,31E-15',
  '800|2,37E+11|4,97E+09|3,68E+05|1,13E+03|3,09E-02|2,08E+11|3,20E+08|1,48E+09|6,96E+02|2,06E-15',
  '820|2,13E+11|3,40E+09|1,93E+05|5,41E+02|1,24E-02|2,02E+11|2,30E+08|1,38E+09|6,96E+02|1,85E-15',
  '840|1,92E+11|2,33E+09|1,02E+05|2,60E+02|4,99E-03|1,97E+11|1,66E+08|1,28E+09|6,96E+02|1,67E-15',
  '860|1,73E+11|1,61E+09|5,36E+04|1,26E+02|2,02E-03|1,91E+11|1,20E+08|1,19E+09|6,96E+02|1,51E-15',
  '880|1,57E+11|1,11E+09|2,85E+04|6,09E+01|8,25E-04|1,86E+11|8,68E+07|1,11E+09|6,96E+02|1,38E-15',
  '900|1,41E+11|7,67E+08|1,52E+04|2,97E+01|3,38E-04|1,81E+11|6,30E+07|1,03E+09|6,96E+02|1,26E-15',
];

const RAW_MEAN = [
  '100|1,16E+14|5,22E+17|9,60E+18|2,00E+18|9,71E+16|1,89E+13|3,76E+11|7,28E-37|1,88E+02|5,73E-07',
  '120|3,08E+13|9,27E+16|3,36E+17|3,95E+16|1,49E+15|3,47E+12|1,77E+12|5,52E-27|3,65E+02|2,03E-08',
  '140|1,83E+13|2,73E+16|5,38E+16|3,84E+15|1,26E+14|8,82E+11|9,45E+12|8,98E-19|6,10E+02|3,44E-09',
  '160|1,39E+13|1,31E+16|1,72E+16|9,29E+14|2,64E+13|3,46E+11|2,73E+13|4,12E-12|7,59E+02|1,20E-09',
  '180|1,16E+13|7,47E+15|7,08E+15|3,22E+14|7,67E+12|2,01E+11|4,18E+13|5,33E-07|8,53E+02|5,46E-10',
  '200|1,00E+13|4,67E+15|3,27E+15|1,31E+14|2,61E+12|1,53E+11|4,31E+13|4,43E-03|9,11E+02|2,84E-10',
  '220|8,91E+12|3,06E+15|1,62E+15|5,81E+13|9,73E+11|1,33E+11|3,64E+13|4,48E+00|9,49E+02|1,61E-10',
  '240|8,00E+12|2,07E+15|8,36E+14|2,71E+13|3,84E+11|1,23E+11|2,82E+13|8,94E+02|9,73E+02|9,60E-11',
  '260|7,24E+12|1,43E+15|4,44E+14|1,31E+13|1,58E+11|1,17E+11|2,10E+13|5,14E+04|9,88E+02|5,97E-11',
  '280|6,59E+12|9,94E+14|2,40E+14|6,48E+12|6,69E+10|1,13E+11|1,56E+13|1,14E+06|9,98E+02|3,83E-11',
  '300|6,01E+12|7,00E+14|1,32E+14|3,27E+12|2,90E+10|1,10E+11|1,15E+13|1,20E+07|1,00E+03|2,52E-11',
  '320|5,50E+12|4,96E+14|7,35E+13|1,67E+12|1,28E+10|1,07E+11|8,60E+12|7,22E+07|1,01E+03|1,69E-11',
  '340|5,04E+12|3,54E+14|4,13E+13|8,66E+11|5,75E+09|1,05E+11|6,45E+12|2,81E+08|1,01E+03|1,16E-11',
  '360|4,62E+12|2,54E+14|2,35E+13|4,54E+11|2,61E+09|1,02E+11|4,86E+12|7,85E+08|1,01E+03|7,99E-12',
  '380|4,24E+12|1,83E+14|1,34E+13|2,40E+11|1,20E+09|1,00E+11|3,68E+12|1,69E+09|1,01E+03|5,60E-12',
  '400|3,90E+12|1,32E+14|7,74E+12|1,28E+11|5,61E+08|9,79E+10|2,79E+12|3,00E+09|1,02E+03|3,96E-12',
  '420|3,59E+12|9,56E+13|4,50E+12|6,90E+10|2,64E+08|9,59E+10|2,13E+12|4,57E+09|1,02E+03|2,83E-12',
  '440|3,30E+12|6,96E+13|2,63E+12|3,74E+10|1,25E+08|9,38E+10|1,63E+12|6,21E+09|1,02E+03|2,03E-12',
  '460|3,04E+12|5,08E+13|1,55E+12|2,05E+10|6,00E+07|9,19E+10|1,25E+12|7,70E+09|1,02E+03|1,47E-12',
  '480|2,80E+12|3,72E+13|9,15E+11|1,13E+10|2,90E+07|9,00E+10|9,59E+11|8,92E+09|1,02E+03|1,07E-12',
  '500|2,58E+12|2,73E+13|5,44E+11|6,24E+09|1,41E+07|8,81E+10|7,39E+11|9,81E+09|1,02E+03|7,85E-13',
  '520|2,38E+12|2,01E+13|3,26E+11|3,48E+09|6,90E+06|8,64E+10|5,71E+11|1,04E+10|1,02E+03|5,78E-13',
  '540|2,20E+12|1,48E+13|1,96E+11|1,95E+09|3,40E+06|8,46E+10|4,42E+11|1,06E+10|1,02E+03|4,29E-13',
  '560|2,03E+12|1,10E+13|1,18E+11|1,10E+09|1,69E+06|8,29E+10|3,43E+11|1,06E+10|1,02E+03|3,19E-13',
  '580|1,88E+12|8,17E+12|7,19E+10|6,24E+08|8,42E+05|8,12E+10|2,67E+11|1,04E+10|1,02E+03|2,39E-13',
  '600|1,74E+12|6,08E+12|4,38E+10|3,55E+08|4,23E+05|7,96E+10|2,08E+11|1,01E+10|1,02E+03|1,80E-13',
  '620|1,61E+12|4,54E+12|2,68E+10|2,04E+08|2,13E+05|7,81E+10|1,62E+11|9,69E+09|1,02E+03|1,36E-13',
  '640|1,49E+12|3,40E+12|1,65E+10|1,17E+08|1,08E+05|7,65E+10|1,27E+11|9,22E+09|1,02E+03|1,04E-13',
  '660|1,38E+12|2,55E+12|1,02E+10|6,78E+07|5,52E+04|7,50E+10|9,91E+10|8,72E+09|1,02E+03|7,98E-14',
  '680|1,28E+12|1,92E+12|6,33E+09|3,94E+07|2,83E+04|7,36E+10|7,78E+10|8,20E+09|1,02E+03|6,16E-14',
  '700|1,18E+12|1,45E+12|3,94E+09|2,30E+07|1,46E+04|7,22E+10|6,11E+10|7,70E+09|1,02E+03|4,80E-14',
  '720|1,10E+12|1,09E+12|2,46E+09|1,34E+07|7,54E+03|7,08E+10|4,81E+10|7,20E+09|1,02E+03|3,76E-14',
  '740|1,02E+12|8,27E+11|1,54E+09|7,91E+06|3,92E+03|6,94E+10|3,80E+10|6,73E+09|1,02E+03|2,98E-14',
  '760|9,45E+11|6,28E+11|9,72E+08|4,67E+06|2,05E+03|6,81E+10|3,00E+10|6,28E+09|1,02E+03|2,38E-14',
  '780|8,78E+11|4,78E+11|6,14E+08|2,77E+06|1,07E+03|6,68E+10|2,37E+10|5,85E+09|1,02E+03|1,92E-14',
  '800|8,16E+11|3,64E+11|3,89E+08|1,65E+06|5,65E+02|6,56E+10|1,88E+10|5,45E+09|1,02E+03|1,57E-14',
  '820|7,58E+11|2,78E+11|2,47E+08|9,83E+05|2,99E+02|6,44E+10|1,49E+10|5,07E+09|1,02E+03|1,29E-14',
  '840|7,05E+11|2,13E+11|1,58E+08|5,89E+05|1,59E+02|6,32E+10|1,19E+10|4,72E+09|1,02E+03|1,07E-14',
  '860|6,56E+11|1,63E+11|1,01E+08|3,54E+05|8,47E+01|6,20E+10|9,45E+09|4,40E+09|1,02E+03|9,03E-15',
  '880|6,11E+11|1,26E+11|6,47E+07|2,14E+05|4,53E+01|6,09E+10|7,54E+09|4,09E+09|1,02E+03|7,67E-15',
  '900|5,69E+11|9,68E+10|4,16E+07|1,29E+05|2,44E+01|5,98E+10|6,02E+09|3,81E+09|1,02E+03|6,59E-15',
];

const RAW_HIGH = [
  '100|1,21E+14|5,70E+17|9,71E+18|1,72E+18|9,73E+16|1,43E+13|5,38E+11|1,57E-36|2,02E+02|5,64E-07',
  '120|3,61E+13|1,15E+17|3,72E+17|3,37E+16|1,62E+15|2,13E+12|3,08E+12|1,36E-26|3,80E+02|2,22E-08',
  '140|2,09E+13|3,51E+16|6,07E+16|3,02E+15|1,43E+14|3,93E+11|1,76E+13|2,12E-18|7,10E+02|3,93E-09',
  '160|1,59E+13|1,86E+16|2,17E+16|6,80E+14|3,51E+13|1,24E+11|5,84E+13|9,74E-12|9,16E+02|1,54E-09',
  '180|1,34E+13|1,15E+16|1,00E+16|2,29E+14|1,21E+13|6,34E+10|1,02E+14|1,26E-06|1,05E+03|7,87E-10',
  '200|1,17E+13|7,72E+15|5,24E+15|9,68E+13|4,91E+12|4,52E+10|1,18E+14|1,05E-02|1,14E+03|4,57E-10',
  '220|1,05E+13|5,42E+15|2,93E+15|4,65E+13|2,18E+12|3,83E+10|1,09E+14|1,06E+01|1,19E+03|2,86E-10',
  '240|9,62E+12|3,93E+15|1,71E+15|2,42E+13|1,03E+12|3,51E+10|9,18E+13|2,11E+03|1,23E+03|1,87E-10',
  '260|8,85E+12|2,90E+15|1,03E+15|1,32E+13|5,02E+11|3,34E+10|7,39E+13|1,22E+05|1,25E+03|1,27E-10',
  '280|8,19E+12|2,17E+15|6,30E+14|7,43E+12|2,52E+11|3,23E+10|5,87E+13|2,68E+06|1,27E+03|8,87E-11',
  '300|7,60E+12|1,64E+15|3,91E+14|4,28E+12|1,30E+11|3,15E+10|4,65E+13|2,84E+07|1,28E+03|6,31E-11',
  '320|7,07E+12|1,25E+15|2,46E+14|2,51E+12|6,77E+10|3,08E+10|3,70E+13|1,71E+08|1,29E+03|4,56E-11',
  '340|6,59E+12|9,53E+14|1,56E+14|1,49E+12|3,59E+10|3,02E+10|2,95E+13|6,65E+08|1,30E+03|3,34E-11',
  '360|6,16E+12|7,32E+14|1,00E+14|8,94E+11|1,93E+10|2,97E+10|2,36E+13|1,85E+09|1,30E+03|2,47E-11',
  '380|5,75E+12|5,65E+14|6,44E+13|5,41E+11|1,05E+10|2,91E+10|1,90E+13|4,00E+09|1,30E+03|1,85E-11',
  '400|5,38E+12|4,37E+14|4,18E+13|3,30E+11|5,75E+09|2,86E+10|1,54E+13|7,10E+09|1,30E+03|1,40E-11',
  '420|5,04E+12|3,39E+14|2,73E+13|2,03E+11|3,18E+09|2,82E+10|1,24E+13|1,08E+10|1,30E+03|1,06E-11',
  '440|4,72E+12|2,64E+14|1,79E+13|1,26E+11|1,78E+09|2,77E+10|1,01E+13|1,47E+10|1,31E+03|8,13E-12',
  '460|4,42E+12|2,06E+14|1,18E+13|7,84E+10|1,00E+09|2,72E+10|8,21E+12|1,82E+10|1,31E+03|6,26E-12',
  '480|4,14E+12|1,62E+14|7,85E+12|4,91E+10|5,66E+08|2,68E+10|6,69E+12|2,11E+10|1,31E+03|4,84E-12',
  '500|3,89E+12|1,27E+14|5,23E+12|3,10E+10|3,23E+08|2,64E+10|5,47E+12|2,32E+10|1,31E+03|3,76E-12',
  '520|3,65E+12|9,97E+13|3,50E+12|1,96E+10|1,85E+08|2,60E+10|4,48E+12|2,45E+10|1,31E+03|2,94E-12',
  '540|3,43E+12|7,86E+13|2,36E+12|1,25E+10|1,07E+08|2,55E+10|3,67E+12|2,51E+10|1,31E+03|2,31E-12',
  '560|3,22E+12|6,21E+13|1,59E+12|8,01E+09|6,21E+07|2,51E+10|3,02E+12|2,51E+10|1,31E+03|1,82E-12',
  '580|3,02E+12|4,92E+13|1,08E+12|5,15E+09|3,62E+07|2,48E+10|2,48E+12|2,47E+10|1,31E+03|1,43E-12',
  '600|2,84E+12|3,91E+13|7,34E+11|3,33E+09|2,13E+07|2,44E+10|2,04E+12|2,39E+10|1,31E+03|1,14E-12',
  '620|2,67E+12|3,11E+13|5,02E+11|2,16E+09|1,25E+07|2,40E+10|1,69E+12|2,29E+10|1,31E+03|9,06E-13',
  '640|2,52E+12|2,48E+13|3,44E+11|1,41E+09|7,41E+06|2,36E+10|1,39E+12|2,18E+10|1,31E+03|7,23E-13',
  '660|2,37E+12|1,98E+13|2,37E+11|9,19E+08|4,41E+06|2,33E+10|1,15E+12|2,06E+10|1,31E+03|5,79E-13',
  '680|2,23E+12|1,58E+13|1,63E+11|6,03E+08|2,63E+06|2,29E+10|9,57E+11|1,94E+10|1,31E+03|4,65E-13',
  '700|2,10E+12|1,27E+13|1,13E+11|3,97E+08|1,58E+06|2,26E+10|7,94E+11|1,82E+10|1,31E+03|3,75E-13',
  '720|1,98E+12|1,02E+13|7,86E+10|2,63E+08|9,50E+05|2,22E+10|6,60E+11|1,70E+10|1,31E+03|3,03E-13',
  '740|1,87E+12|8,21E+12|5,48E+10|1,74E+08|5,74E+05|2,19E+10|5,50E+11|1,59E+10|1,31E+03|2,46E-13',
  '760|1,76E+12|6,62E+12|3,83E+10|1,16E+08|3,48E+05|2,16E+10|4,58E+11|1,48E+10|1,31E+03|2,00E-13',
  '780|1,66E+12|5,35E+12|2,68E+10|7,74E+07|2,12E+05|2,13E+10|3,82E+11|1,38E+10|1,31E+03|1,63E-13',
  '800|1,57E+12|4,33E+12|1,88E+10|5,19E+07|1,29E+05|2,10E+10|3,20E+11|1,29E+10|1,31E+03|1,34E-13',
  '820|1,48E+12|3,51E+12|1,33E+10|3,48E+07|7,93E+04|2,07E+10|2,67E+11|1,20E+10|1,31E+03|1,10E-13',
  '840|1,40E+12|2,85E+12|9,39E+09|2,35E+07|4,87E+04|2,04E+10|2,24E+11|1,12E+10|1,31E+03|9,06E-14',
  '860|1,32E+12|2,32E+12|6,65E+09|1,59E+07|3,01E+04|2,01E+10|1,88E+11|1,04E+10|1,31E+03|7,50E-14',
  '880|1,25E+12|1,89E+12|4,72E+09|1,07E+07|1,86E+04|1,98E+10|1,58E+11|9,67E+09|1,31E+03|6,23E-14',
  '900|1,18E+12|1,54E+12|3,36E+09|7,30E+06|1,16E+04|1,95E+10|1,33E+11|9,01E+09|1,31E+03|6,00E-14',
];

const FIELD_KEYS = ['km', 'nHe', 'nO', 'nN2', 'nO2', 'nAr', 'nH', 'nN', 'nOanom', 'tK', 'rho'];

/**
 * Read one printed row ("400|2,27E+12|...") into an object: km, the eight number densities (m^-3), tK (K), rho (kg/m3).
 * @param {string} line @returns {{km:number,nHe:number,nO:number,nN2:number,nO2:number,nAr:number,nH:number,nN:number,nOanom:number,tK:number,rho:number}}
 */
export function parseRow(line) {
  const parts = String(line).split('|');
  const row = {};
  FIELD_KEYS.forEach((k, i) => { row[k] = Number(parts[i].trim().replace(',', '.')); });
  return row;
}

/**
 * Rows where the printed density disagrees with the page's own gases (found by the sum check, 2026-11-21). Only one:
 * the high table at 900 km prints rho 6,00E-14, 4 % under the 880 km row while the steps above it are 17-20 %, and the eight
 * gases of the same row add up to 5.23E-14 (12.9 % less; every other row of all three tables is within 2.6 %). A misprint on the
 * page. `rho` keeps the printed number; `rhoUsed` is what the chart draws (for this row the sum of the gases).
 */
export const SOURCE_MISPRINTS = Object.freeze([{ table: 'high', km: 900, field: 'rho', printed: 6.00e-14 }]);

const build = (raw, table) => Object.freeze(raw.map((l) => {
  const row = parseRow(l);
  row.rhoUsed = SOURCE_MISPRINTS.some((m) => m.table === table && m.km === row.km) ? rowMassSum(row) : row.rho;
  return Object.freeze(row);
}));

/** The three tables, 41 rows each (100..900 km every 20 km): { low, mean, high }. */
export const TABLES = Object.freeze({ low: build(RAW_LOW, 'low'), mean: build(RAW_MEAN, 'mean'), high: build(RAW_HIGH, 'high') });

/** The printed text of the rows (tests compare against it; kept so a probe can diff the file against a fresh read). */
export const RAW_ROWS = Object.freeze({ low: RAW_LOW, mean: RAW_MEAN, high: RAW_HIGH });

/** Mass of one particle of a gas, kg. */
export function particleMassKg(gas) {
  const g = typeof gas === 'string' ? GASES.find((x) => x.key === gas) : gas;
  return g.molarMass * 1e-3 / AVOGADRO;
}

/** Mass density contributed by every gas of a row, kg/m3 (anomalous oxygen included). */
export function rowMassSum(row) {
  let s = 0;
  for (const g of GASES) s += row[g.key] * particleMassKg(g);
  return s;
}

/** Clamp a height to the table range 100..900 km. */
function clampKm(altKm) { return Math.min(Math.max(altKm, ROW0_KM), ROW_TOP_KM); }

/** Row position of a height: [index of the lower row, 0..1 along to the next]. */
function rowAt(altKm) {
  const x = (clampKm(altKm) - ROW0_KM) / ROW_STEP_KM;
  const i = Math.min(ROW_COUNT - 2, Math.floor(x));
  return [i, x - i];
}

/** Clamp a Sun level to 65..250. */
export function clampF107(f) { return Math.min(Math.max(f, F107_LOW), F107_HIGH); }

/**
 * How far a Sun level sits along the tables: { from, to, t } where the level is `from` at t = 0 and `to` at t = 1 (the same
 * 65 / 140 / 250 split `SunStorms.sunMultiplier` uses). A table key gives that table alone (t = 0).
 * @param {string|number} level 'low' | 'mean' | 'high' or an F10.7 number
 * @returns {{from:string,to:string,t:number}}
 */
export function levelWeights(level) {
  if (typeof level === 'string') {
    if (!TABLES[level]) throw new Error(`AirGases: unknown level ${level}`);
    return { from: level, to: level, t: 0 };
  }
  const f = clampF107(level);
  if (f <= F107_MOD) return { from: 'mean', to: 'low', t: (F107_MOD - f) / (F107_MOD - F107_LOW) };
  return { from: 'mean', to: 'high', t: (f - F107_MOD) / (F107_HIGH - F107_MOD) };
}

/** ln of a row field at a height, interpolated in height, in one table. */
function lnAt(table, key, altKm) {
  const [i, w] = rowAt(altKm);
  const a = Math.log(TABLES[table][i][key]);
  const b = Math.log(TABLES[table][i + 1][key]);
  return a * (1 - w) + b * w;
}

/** ln of a row field at a height and Sun level (in ln between tables, as `sunMultiplier`). */
function lnLevel(key, altKm, level) {
  const { from, to, t } = levelWeights(level);
  const a = lnAt(from, key, altKm);
  if (t === 0) return a;
  return a + (lnAt(to, key, altKm) - a) * t;
}

/**
 * Whole-air mass density, kg/m3, at a height (km, held to 100..900) and Sun level.
 * @param {number} altKm @param {string|number} level 'low' | 'mean' | 'high' or an F10.7 number
 * @returns {number}
 */
export function totalDensity(altKm, level) { return Math.exp(lnLevel('rhoUsed', altKm, level)); }

/**
 * Mass density of one gas, kg/m3 (n x molar mass / Avogadro), at a height and Sun level.
 * @param {string} gasKey a `GASES` key, e.g. 'nO', 'nN2', 'nHe'
 * @param {number} altKm @param {string|number} level
 * @returns {number}
 */
export function gasDensity(gasKey, altKm, level) {
  return Math.exp(lnLevel(gasKey, altKm, level)) * particleMassKg(gasKey);
}

/**
 * Mass density of all the oxygen atoms, kg/m3: atomic oxygen plus the anomalous oxygen column (also atoms; at 900 km on a quiet Sun
 * it is larger than the plain column, 1.03e9 against 7.67e8 per m3).
 * @param {number} altKm @param {string|number} level
 * @returns {number}
 */
export function oxygenAtomsDensity(altKm, level) {
  return gasDensity('nO', altKm, level) + gasDensity('nOanom', altKm, level);
}

/**
 * Every gas at a height and Sun level: number density (m^-3) and mass density (kg/m3), plus the whole air and the temperature.
 * @param {number} altKm @param {string|number} level
 * @returns {{altKm:number, total:number, tK:number, gases: Array<{key:string,label:string,n:number,rho:number}>}}
 */
export function gasesAt(altKm, level) {
  return {
    altKm: clampKm(altKm),
    total: totalDensity(altKm, level),   // the printed rho (the gases' sum at the one misprinted row)
    tK: Math.exp(lnLevel('tK', altKm, level)),
    gases: GASES.map((g) => {
      const n = Math.exp(lnLevel(g.key, altKm, level));
      return { key: g.key, label: g.label, n, rho: n * particleMassKg(g) };
    }),
  };
}

/**
 * Today's level, plain words (F10.7 against the three tables). Outer cut points as `SunStorms.sunWord` (95 / 150), so the map
 * and this page never disagree: below 95 quiet, 150 and above busy.
 * @param {number} f107 @returns {string}
 */
export function todaySunWords(f107) {
  if (f107 < 95) return 'a lot quieter than average';
  if (f107 < 125) return 'a bit quieter than average';
  if (f107 < 150) return 'about average';
  if (f107 < 200) return 'a bit busier than average';
  return 'much busier than average';
}
