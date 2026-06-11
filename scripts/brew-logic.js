/*
  Funcleson Brew Day Builder
  brew-logic.js

  Pure brewing math and estimator helpers.
  Keep UI concerns out of this file so future formula edits stay isolated.
*/
(function(){
  "use strict";

  function convertToPounds(amount, unit){
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const normalized = String(unit || "").toLowerCase();
    if (normalized === "lb") return value;
    if (normalized === "oz") return value / 16;
    if (normalized === "kg") return value * 2.20462;
    if (normalized === "g") return value / 453.592;
    return 0;
  }

  function formatWeightLb(value){
    if (!Number.isFinite(value) || value <= 0) return "0.00 lb";
    return `${value.toFixed(2)} lb`;
  }

  function calculateStrikeTemp(waterQt, grainLb, targetMashTemp, grainTemp){
    if (!(waterQt > 0 && grainLb > 0 && targetMashTemp > 0 && grainTemp > 0)) return null;
    return ((0.2 / (waterQt / grainLb)) * (targetMashTemp - grainTemp)) + targetMashTemp;
  }

  function calculateBiabPlan({
    batchSize,
    grainLb,
    mashTemp,
    mashTime,
    boilTime,
    boilOffRate,
    trub,
    absorption,
    grainTemp,
    notes = ""
  } = {}){
    const resolvedBoilTime = boilTime > 0 ? boilTime : 60;
    const resolvedBoilOffRate = boilOffRate > 0 ? boilOffRate : 1.0;
    const resolvedTrub = Number.isFinite(trub) && trub >= 0 ? trub : 0.5;
    const resolvedAbsorption = absorption > 0 ? absorption : 0.125;
    const hasPlan = batchSize > 0 && grainLb > 0;

    const boilOffGal = hasPlan ? resolvedBoilOffRate * (resolvedBoilTime / 60) : null;
    const grainAbsGal = hasPlan ? grainLb * resolvedAbsorption : null;
    const totalWater = hasPlan ? batchSize + resolvedTrub + boilOffGal + grainAbsGal : null;
    const preBoilVol = hasPlan ? totalWater - grainAbsGal : null;
    const postBoilVol = hasPlan ? preBoilVol - boilOffGal : null;
    const mashVolume = hasPlan ? totalWater + (grainLb * 0.08) : null;
    const waterQt = hasPlan ? totalWater * 4 : null;
    const ratio = hasPlan && grainLb > 0 ? waterQt / grainLb : null;
    const strikeTemp = hasPlan ? calculateStrikeTemp(waterQt, grainLb, mashTemp, grainTemp) : null;

    return {
      hasPlan,
      batchSize: Number.isFinite(batchSize) ? batchSize : null,
      grainLb: grainLb > 0 ? grainLb : null,
      mashTemp: Number.isFinite(mashTemp) ? mashTemp : null,
      mashTime: Number.isFinite(mashTime) ? mashTime : null,
      boilTime: Number.isFinite(resolvedBoilTime) ? resolvedBoilTime : null,
      boilOffRate: Number.isFinite(resolvedBoilOffRate) ? resolvedBoilOffRate : null,
      trub: Number.isFinite(resolvedTrub) ? resolvedTrub : null,
      absorption: Number.isFinite(resolvedAbsorption) ? resolvedAbsorption : null,
      grainTemp: Number.isFinite(grainTemp) ? grainTemp : null,
      notes: notes || "",
      totalWater,
      preBoilVol,
      postBoilVol,
      mashVolume,
      waterQt,
      ratio,
      strikeTemp
    };
  }

  function calcABV(og, fg){
    if (!og || !fg || Number(og) <= Number(fg)) return null;
    return (Number(og) - Number(fg)) * 131.25;
  }

  function calcPoints(og, fg){
    if (!og || !fg || Number(og) <= Number(fg)) return null;
    return (Number(og) - Number(fg)) * 1000;
  }

  function calcAttenuation(og, currentGravity){
    if (!og || !currentGravity || Number(og) <= Number(currentGravity) || Number(og) <= 1) return null;
    return ((Number(og) - Number(currentGravity)) / (Number(og) - 1)) * 100;
  }

  function estimateTinsethIBU(og, volumeGal, hopsRows){
    const ogNum = parseFloat(og);
    const vol = parseFloat(volumeGal);
    if (!ogNum || ogNum <= 1 || !vol || vol <= 0) return null;
    let totalIBU = 0;
    (hopsRows || []).forEach((row) => {
      if (!row.name || !row.amount) return;
      const useStage = (row.use || "Boil").toLowerCase();
      if (useStage !== "boil" && useStage !== "first wort") return;
      const ozWeight = row.unit === "g" ? parseFloat(row.amount) / 28.3495 : parseFloat(row.amount);
      const minutes = parseFloat(row.time) || 0;
      if (!ozWeight || ozWeight <= 0 || minutes <= 0) return;
      const aa = row.aa ? parseFloat(row.aa) / 100 : 0.10;
      const bignessFactor = 1.65 * Math.pow(0.000125, ogNum - 1);
      const boilTimeFactor = (1 - Math.exp(-0.04 * minutes)) / 4.15;
      const utilization = bignessFactor * boilTimeFactor;
      const mgPerLiter = (aa * ozWeight * 7490) / (vol * 3.78541);
      totalIBU += utilization * mgPerLiter;
    });
    return totalIBU > 0 ? totalIBU : null;
  }

  function estimateMoreySRM(volumeGal, fermentableRows){
    const vol = parseFloat(volumeGal);
    if (!vol || vol <= 0) return null;
    let totalMCU = 0;
    (fermentableRows || []).forEach((row) => {
      if (!row.name || !row.amount) return;
      const lb = convertToPounds(row.amount, row.unit);
      const lovibond = parseFloat(row.lovibond) || 0;
      if (lb <= 0 || lovibond <= 0) return;
      totalMCU += (lb * lovibond) / vol;
    });
    if (totalMCU <= 0) return null;
    return 1.4922 * Math.pow(totalMCU, 0.6859);
  }

  function srmToColor(srm){
    if (srm <= 2) return "#FFE699";
    if (srm <= 4) return "#FFD878";
    if (srm <= 6) return "#FFCA5A";
    if (srm <= 9) return "#FFBF42";
    if (srm <= 12) return "#ECA120";
    if (srm <= 15) return "#BF8120";
    if (srm <= 20) return "#A05E1E";
    if (srm <= 30) return "#6B3A1E";
    if (srm <= 40) return "#4A2410";
    return "#2A1408";
  }

  function calculatePrimingSugarCorn({ volumeGallons, beerTempF, targetVolumesCo2 } = {}){
    if (!(volumeGallons > 0 && beerTempF > 0 && targetVolumesCo2 > 0)) return null;
    const dissolvedVolumes = -0.9753 * Math.log(beerTempF) + 4.9648;
    const neededVolumes = targetVolumesCo2 - dissolvedVolumes;
    const cornSugarOz = neededVolumes > 0 ? neededVolumes * volumeGallons * 0.536 : 0;
    return {
      dissolvedVolumes,
      neededVolumes,
      cornSugarOz,
      cornSugarGrams: cornSugarOz * 28.35
    };
  }

  function calculateStarterRecommendation({ og, volumeGallons, beerType = "ale", packs = 1 } = {}){
    if (!(og > 1 && volumeGallons > 0)) return null;
    const plato = (-1 * 616.868) + (1111.14 * og) - (630.272 * og * og) + (135.997 * og * og * og);
    const pitchRateMCellsPerMlPerPlato = beerType === "lager" ? 1.5 : 0.75;
    const volumeML = volumeGallons * 3785.41;
    const cellsNeededBillions = pitchRateMCellsPerMlPerPlato * volumeML * plato / 1000;
    const cellsAvailableBillions = (packs || 1) * 100;
    const deficitBillions = cellsNeededBillions - cellsAvailableBillions;
    const recommendedStarterLiters = deficitBillions > 0 ? Math.max(0.5, Math.ceil(deficitBillions / 100 * 10) / 10) : 0;
    return {
      plato,
      pitchRateMCellsPerMlPerPlato,
      volumeML,
      cellsNeededBillions,
      cellsAvailableBillions,
      deficitBillions,
      needsStarter: deficitBillions > 0,
      recommendedStarterLiters,
      dmeGrams: recommendedStarterLiters * 100
    };
  }

  function calculateBottleCount({ gallons, bottleOz = 12, lossPct = 5 } = {}){
    if (!(gallons > 0 && bottleOz > 0)) return null;
    const normalizedLossPct = Math.max(0, lossPct);
    const packagedOz = gallons * 128 * (1 - (normalizedLossPct / 100));
    const fullBottles = Math.floor(packagedOz / bottleOz);
    const leftoverOz = Math.max(0, packagedOz - (fullBottles * bottleOz));
    return {
      packagedOz,
      fullBottles,
      leftoverOz,
      lossPct: normalizedLossPct
    };
  }

  function calculateKegPressure({ tempF, targetVolumesCo2 } = {}){
    if (!(tempF > 0 && targetVolumesCo2 > 0)) return null;
    const psi = (-16.6999 - (0.0101059 * tempF) + (0.00116512 * tempF * tempF) + (0.173354 * tempF * targetVolumesCo2) + (4.24267 * targetVolumesCo2) - (0.0684226 * targetVolumesCo2 * targetVolumesCo2));
    return { psi: Math.max(0, psi) };
  }

  window.BrewLogic = {
    convertToPounds,
    formatWeightLb,
    calculateStrikeTemp,
    calculateBiabPlan,
    calcABV,
    calcPoints,
    calcAttenuation,
    estimateTinsethIBU,
    estimateMoreySRM,
    srmToColor,
    calculatePrimingSugarCorn,
    calculateStarterRecommendation,
    calculateBottleCount,
    calculateKegPressure
  };
})();
