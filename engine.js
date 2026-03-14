// Financial Model Calculation Engine
// Replicates the Excel model: Model_Finansowy_Oddzial_v3.xlsx

const MONTHS = 72;

// Default parameters (yellow cells from Zalozenia sheet)
function getDefaultParams() {
  return {
    // DEPOZYTY
    newDepositClientsPerMonth: 200,
    avgDepositPerClient: 15000,
    depositMarginPA: 0.04,
    // POZYCZKI
    avgLoanAmount: 25000,
    loanMarginPA: 0.06,
    // INWESTYCJE
    capex: 2500000,
    // KOSZTY OPERACYJNE
    salariesPerMonth: 100000,
    rentPerMonth: 50000,
    otherCostsPerMonth: 10000,
    // INFLACJA
    annualInflation: 0.025,
    // ATRYCJA KLIENTOW DEPOZYTOWYCH (yearly, years 1-6)
    attritionRates: [0.08, 0.08, 0.08, 0.08, 0.08, 0.08],
    // AMORTYZACJA (MoB 0-144, Saldo %)
    amortization: [
      1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.62, 0.6,
      0.55, 0.52, 0.5, 0.48, 0.46, 0.44, 0.42, 0.4, 0.38, 0.36,
      0.34, 0.32, 0.3, 0.28, 0.25,
      // MoB 25-144: each = prev * 0.98
      ...(() => {
        const arr = [];
        let v = 0.25;
        for (let i = 25; i <= 143; i++) { v *= 0.98; arr.push(v); }
        arr.push(0); // MoB 144
        return arr;
      })()
    ],
    // PENETRACJA (months 0-60, default all 0.0025)
    penetration: new Array(61).fill(0.0025),
  };
}

function calculate(params) {
  const p = { ...getDefaultParams(), ...params };
  // Ensure arrays are proper
  if (!Array.isArray(p.attritionRates) || p.attritionRates.length < 6) {
    p.attritionRates = getDefaultParams().attritionRates;
  }
  if (!Array.isArray(p.amortization) || p.amortization.length < 145) {
    p.amortization = getDefaultParams().amortization;
  }
  if (!Array.isArray(p.penetration) || p.penetration.length < 61) {
    p.penetration = getDefaultParams().penetration;
  }

  // ===== STEP 1: Inflation index per month =====
  const inflationIndex = new Array(MONTHS);
  for (let m = 0; m < MONTHS; m++) {
    inflationIndex[m] = Math.pow(1 + p.annualInflation, m / 12);
  }

  // ===== STEP 2: Cohort deposit clients (Depozyty_kohorty) =====
  // cohort c (1-indexed) starts in month c, row=c, col=month
  // Formula: if month < cohort, 0, else newClients * product of attrition factors
  // Attrition: (1-rate_year1)^(min(elapsed,12)/12) * (1-rate_year2)^(max(0,min(elapsed-12,12))/12) * ...
  const cohortClients = new Array(MONTHS); // cohortClients[month] = total active clients
  for (let m = 0; m < MONTHS; m++) {
    let total = 0;
    for (let c = 0; c < MONTHS; c++) {
      if (m < c) continue; // cohort c hasn't started yet
      const elapsed = m - c;
      let clients = p.newDepositClientsPerMonth;
      for (let yr = 0; yr < 6; yr++) {
        const offset = yr * 12;
        const exposure = Math.max(0, Math.min(elapsed - offset, 12)) / 12;
        clients *= Math.pow(1 - p.attritionRates[yr], exposure);
      }
      total += clients;
    }
    cohortClients[m] = total;
  }

  // ===== STEP 3: New loans per month (Nowe_pozyczki) =====
  // For each cohort c and month m: depositClients(c,m) * penetration(m-c)
  // Then sum across cohorts for total new loans in month m
  const newLoansCount = new Array(MONTHS);
  for (let m = 0; m < MONTHS; m++) {
    let total = 0;
    for (let c = 0; c < MONTHS; c++) {
      if (m < c) continue;
      const elapsed = m - c;
      // Calculate cohort c's clients at month m
      let clients = p.newDepositClientsPerMonth;
      for (let yr = 0; yr < 6; yr++) {
        const offset = yr * 12;
        const exposure = Math.max(0, Math.min((m - c) - offset, 12)) / 12;
        clients *= Math.pow(1 - p.attritionRates[yr], exposure);
      }
      const penIdx = elapsed;
      const pen = penIdx < p.penetration.length ? p.penetration[penIdx] : 0;
      total += clients * pen;
    }
    newLoansCount[m] = total;
  }

  // ===== STEP 4: Loan portfolio (Portfel) =====
  // For each origination month o, its contribution at month m:
  // newLoansCount[o] * avgLoanAmount * inflationIndex[o] * amortization[m-o]
  const portfolioBalance = new Array(MONTHS);
  for (let m = 0; m < MONTHS; m++) {
    let total = 0;
    for (let o = 0; o < MONTHS; o++) {
      if (m < o) continue;
      const age = m - o;
      const amort = age < p.amortization.length ? p.amortization[age] : 0;
      total += newLoansCount[o] * p.avgLoanAmount * inflationIndex[o] * amort;
    }
    portfolioBalance[m] = total;
  }

  // ===== STEP 5: Monthly projection (Projekcja) =====
  const projection = [];
  let cumulativeRevenue = 0;
  let cumulativeExpenses = 0;
  let cumulativeResult = 0;
  let breakEvenMonth = null;
  let paybackMonth = null;

  for (let m = 0; m < MONTHS; m++) {
    const month = m + 1;
    const year = Math.floor(m / 12) + 1;
    const inf = inflationIndex[m];

    // Deposits
    const depositClients = cohortClients[m];
    const depositPerClient = p.avgDepositPerClient * inf;
    const depositBalance = depositClients * depositPerClient;
    const depositRevenue = depositBalance * p.depositMarginPA / 12;

    // Loans
    const loanBalance = portfolioBalance[m];
    const loanRevenue = loanBalance * p.loanMarginPA / 12;

    // Total revenue
    const totalRevenue = depositRevenue + loanRevenue;

    // Operating costs (adjusted for inflation)
    const salaries = p.salariesPerMonth * inf;
    const rent = p.rentPerMonth * inf;
    const otherCosts = p.otherCostsPerMonth * inf;
    const totalOpCosts = salaries + rent + otherCosts;

    // CAPEX only in month 1
    const capex = month === 1 ? p.capex : 0;

    // Results
    const operatingResult = totalRevenue - totalOpCosts;
    const totalExpenses = totalOpCosts + capex;

    cumulativeRevenue += totalRevenue;
    cumulativeExpenses += totalExpenses;
    cumulativeResult = cumulativeRevenue - cumulativeExpenses;

    // Break-even: first month where operating result > 0
    if (breakEvenMonth === null && operatingResult > 0) {
      breakEvenMonth = month;
    }
    // Payback: first month where cumulative result > 0
    if (paybackMonth === null && cumulativeResult > 0) {
      paybackMonth = month;
    }

    // New loans info
    const newLoansValue = newLoansCount[m] * p.avgLoanAmount * inf;

    projection.push({
      month,
      year,
      inflationIndex: inf,
      newDepositClients: p.newDepositClientsPerMonth,
      totalDepositClients: depositClients,
      depositPerClient,
      depositBalance,
      depositRevenue,
      newLoansCount: newLoansCount[m],
      loanAmount: p.avgLoanAmount * inf,
      newLoansValue,
      loanBalance,
      loanRevenue,
      totalRevenue,
      salaries,
      rent,
      otherCosts,
      totalOpCosts,
      capex,
      operatingResult,
      totalExpenses,
      cumulativeRevenue,
      cumulativeExpenses,
      cumulativeResult,
    });
  }

  // ===== STEP 6: Annual summary (Podsumowanie) =====
  const annualSummary = [];
  for (let yr = 1; yr <= 6; yr++) {
    const startIdx = (yr - 1) * 12;
    const endIdx = yr * 12;
    const yearData = projection.slice(startIdx, endIdx);

    const depositRevenueSum = yearData.reduce((s, d) => s + d.depositRevenue, 0);
    const loanRevenueSum = yearData.reduce((s, d) => s + d.loanRevenue, 0);
    const totalRevenueSum = yearData.reduce((s, d) => s + d.totalRevenue, 0);
    const salariesSum = yearData.reduce((s, d) => s + d.salaries, 0);
    const rentSum = yearData.reduce((s, d) => s + d.rent, 0);
    const otherCostsSum = yearData.reduce((s, d) => s + d.otherCosts, 0);
    const totalOpCostsSum = yearData.reduce((s, d) => s + d.totalOpCosts, 0);
    const capexSum = yearData.reduce((s, d) => s + d.capex, 0);
    const totalExpensesSum = yearData.reduce((s, d) => s + d.totalExpenses, 0);
    const yearResult = totalRevenueSum - totalExpensesSum;

    annualSummary.push({
      year: yr,
      depositRevenue: depositRevenueSum,
      loanRevenue: loanRevenueSum,
      totalRevenue: totalRevenueSum,
      salaries: salariesSum,
      rent: rentSum,
      otherCosts: otherCostsSum,
      totalOpCosts: totalOpCostsSum,
      capex: capexSum,
      totalExpenses: totalExpensesSum,
      yearResult,
      cumulativeResult: yearData[yearData.length - 1].cumulativeResult,
    });
  }

  // Totals row
  const totals = {
    year: 'Razem',
    depositRevenue: annualSummary.reduce((s, y) => s + y.depositRevenue, 0),
    loanRevenue: annualSummary.reduce((s, y) => s + y.loanRevenue, 0),
    totalRevenue: annualSummary.reduce((s, y) => s + y.totalRevenue, 0),
    salaries: annualSummary.reduce((s, y) => s + y.salaries, 0),
    rent: annualSummary.reduce((s, y) => s + y.rent, 0),
    otherCosts: annualSummary.reduce((s, y) => s + y.otherCosts, 0),
    totalOpCosts: annualSummary.reduce((s, y) => s + y.totalOpCosts, 0),
    capex: annualSummary.reduce((s, y) => s + y.capex, 0),
    totalExpenses: annualSummary.reduce((s, y) => s + y.totalExpenses, 0),
    yearResult: annualSummary.reduce((s, y) => s + y.yearResult, 0),
    cumulativeResult: annualSummary[annualSummary.length - 1].cumulativeResult,
  };

  // Chart data: cumulative result per month
  const chartData = projection.map(d => ({
    month: d.month,
    cumulativeResult: d.cumulativeResult,
    cumulativeRevenue: d.cumulativeRevenue,
    cumulativeExpenses: d.cumulativeExpenses,
  }));

  return {
    breakEvenMonth: breakEvenMonth || 'Nie osiągnięto',
    paybackMonth: paybackMonth || 'Nie osiągnięto',
    annualSummary,
    totals,
    chartData,
    projection,
  };
}

module.exports = { calculate, getDefaultParams };
