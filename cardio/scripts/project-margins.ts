import {
  HYPOTHETICAL_PRICE_BANDS,
  INSTITUTION_ACTIVE_SEAT_SCENARIOS,
  REWRITTEN_BASELINE_COSTS,
  TIER_USAGE_SCENARIOS,
  adjustedCostPerPdf,
  breakEvenCostPerPdf,
  breakEvenPdfsPerMonth,
  computeContributionMargin,
  formatCurrency,
  formatPercent,
  marginZone,
  maxActiveSeatsBeforeNegativeMargin,
  maxPdfsForTargetMargin,
  requiredPriceForTargetMargin,
  type CostSensitivity,
  type Tier,
  type UsageBand,
} from '../lib/economics/margin-projection';

type CliArgs = {
  studentPrice?: number;
  boardsPrice?: number;
  institutionPrice?: number;
};

type RedZoneRow = {
  tier: Tier;
  scenario: string;
  sensitivity: CostSensitivity;
  priceLabel: string;
  marginPercent: number;
  marginDollars: number;
};

function parseArgs(): CliArgs {
  const args = Object.fromEntries(
    process.argv.slice(2).map(arg => {
      const [key, value] = arg.replace(/^--/, '').split('=');
      return [key, value];
    }),
  );

  return {
    studentPrice: args.studentPrice ? Number(args.studentPrice) : undefined,
    boardsPrice: args.boardsPrice ? Number(args.boardsPrice) : undefined,
    institutionPrice: args.institutionPrice ? Number(args.institutionPrice) : undefined,
  };
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function printHypotheticalScenarioTables(redZoneRows: RedZoneRow[]): void {
  console.log('# Hypothetical Pricing Bands');
  console.log('');
  console.log('Baseline rewritten workload costs:');
  Object.values(REWRITTEN_BASELINE_COSTS).forEach(workload => {
    console.log(`- ${workload.label}: ${formatCurrency(workload.costPerPdf)}`);
  });
  console.log('');

  (Object.keys(HYPOTHETICAL_PRICE_BANDS) as Tier[]).forEach(tier => {
    const scenarios = TIER_USAGE_SCENARIOS.filter(scenario => scenario.tier === tier);
    console.log(`## ${titleCase(tier)}`);
    console.log('');

    (['current', 'optimized_25', 'optimized_50'] as CostSensitivity[]).forEach(sensitivity => {
      console.log(`### Cost sensitivity: ${titleCase(sensitivity)}`);
      console.log('');
      console.log(`| Scenario | Workload | PDFs/mo | ${HYPOTHETICAL_PRICE_BANDS[tier].map(price => `${formatCurrency(price)}`).join(' | ')} |`);
      console.log(`| --- | --- | ---: | ${HYPOTHETICAL_PRICE_BANDS[tier].map(() => '---').join(' | ')} |`);

      scenarios.forEach(scenario => {
        const cells = HYPOTHETICAL_PRICE_BANDS[tier].map(price => {
          const costPerPdf = adjustedCostPerPdf(scenario.workload, sensitivity);
          const margin = computeContributionMargin(price, scenario.pdfsPerMonth, costPerPdf);
          const zone = marginZone(margin.marginPercent);
          if (zone !== 'healthy') {
            redZoneRows.push({
              tier,
              scenario: scenario.label,
              sensitivity,
              priceLabel: formatCurrency(price),
              marginPercent: margin.marginPercent,
              marginDollars: margin.marginDollars,
            });
          }
          return `${formatCurrency(margin.marginDollars)} (${formatPercent(margin.marginPercent)})`;
        });

        console.log(`| ${scenario.label} | ${REWRITTEN_BASELINE_COSTS[scenario.workload].label} | ${scenario.pdfsPerMonth} | ${cells.join(' | ')} |`);
      });

      console.log('');
    });
  });
}

function printInstitutionOrgTables(redZoneRows: RedZoneRow[]): void {
  const institutionPerSeatScenarios = TIER_USAGE_SCENARIOS.filter(scenario => scenario.tier === 'institution');
  console.log('# Institution Org-Level Projections');
  console.log('');

  (['current', 'optimized_25', 'optimized_50'] as CostSensitivity[]).forEach(sensitivity => {
    console.log(`## Cost sensitivity: ${titleCase(sensitivity)}`);
    console.log('');
    institutionPerSeatScenarios.forEach(perSeatScenario => {
      console.log(`### ${perSeatScenario.label}`);
      console.log('');
      console.log(`| Active seats | ${HYPOTHETICAL_PRICE_BANDS.institution.map(price => `${formatCurrency(price)}`).join(' | ')} |`);
      console.log(`| ---: | ${HYPOTHETICAL_PRICE_BANDS.institution.map(() => '---').join(' | ')} |`);

      INSTITUTION_ACTIVE_SEAT_SCENARIOS.forEach(({ activeSeats }) => {
        const cells = HYPOTHETICAL_PRICE_BANDS.institution.map(price => {
          const costPerPdf = adjustedCostPerPdf(perSeatScenario.workload, sensitivity);
          const orgMargin = computeContributionMargin(price, activeSeats * perSeatScenario.pdfsPerMonth, costPerPdf);
          const zone = marginZone(orgMargin.marginPercent);
          if (zone !== 'healthy') {
            redZoneRows.push({
              tier: 'institution',
              scenario: `${perSeatScenario.label} / ${activeSeats} active seats`,
              sensitivity,
              priceLabel: formatCurrency(price),
              marginPercent: orgMargin.marginPercent,
              marginDollars: orgMargin.marginDollars,
            });
          }
          return `${formatCurrency(orgMargin.marginDollars)} (${formatPercent(orgMargin.marginPercent)})`;
        });
        console.log(`| ${activeSeats} | ${cells.join(' | ')} |`);
      });

      console.log('');
    });
  });
}

function printActualPriceFramework(cliArgs: CliArgs): void {
  console.log('# Actual-Price Framework');
  console.log('');

  const prices = {
    student: cliArgs.studentPrice,
    boards: cliArgs.boardsPrice,
    institution: cliArgs.institutionPrice,
  } as const;

  if (!prices.student && !prices.boards && !prices.institution) {
    console.log('Provide real prices with:');
    console.log('`npm run margin:project -- --studentPrice=X --boardsPrice=Y --institutionPrice=Z`');
    console.log('');
    console.log('Template inputs:');
    console.log('- Student price = X');
    console.log('- Boards price = Y');
    console.log('- Institution price = Z');
    console.log('');
    console.log('Use the same formulas:');
    console.log('- `margin_dollars = monthly_price - (pdfs_per_month * cost_per_pdf)`');
    console.log('- `margin_percent = margin_dollars / monthly_price`');
    return;
  }

  (Object.entries(prices) as Array<[Tier, number | undefined]>).forEach(([tier, price]) => {
    if (!price) return;
    const scenarios = TIER_USAGE_SCENARIOS.filter(scenario => scenario.tier === tier);
    console.log(`## ${titleCase(tier)} at ${formatCurrency(price)}`);
    console.log('');
    console.log('| Scenario | Current | -25% cost | -50% cost |');
    console.log('| --- | --- | --- | --- |');
    scenarios.forEach(scenario => {
      const cells = (['current', 'optimized_25', 'optimized_50'] as CostSensitivity[]).map(sensitivity => {
        const costPerPdf = adjustedCostPerPdf(scenario.workload, sensitivity);
        const margin = computeContributionMargin(price, scenario.pdfsPerMonth, costPerPdf);
        return `${formatCurrency(margin.marginDollars)} (${formatPercent(margin.marginPercent)})`;
      });
      console.log(`| ${scenario.label} | ${cells.join(' | ')} |`);
    });
    console.log('');
  });
}

function printBreakEvenThresholds(): void {
  console.log('# Break-Even Thresholds');
  console.log('');

  console.log('## Scenario examples');
  const boardsExpectedMonthlyCost = 4 * REWRITTEN_BASELINE_COSTS.boards_150.costPerPdf;
  console.log(`- Boards price needed to stay above 70% margin for 4 x BOARDS 150 jobs: ${formatCurrency(requiredPriceForTargetMargin(boardsExpectedMonthlyCost, 0.7))}`);
  console.log(`- STANDARD 150 uploads a $39 Student plan can support while staying at or above 60% margin: ${maxPdfsForTargetMargin(39, REWRITTEN_BASELINE_COSTS.standard_150.costPerPdf, 0.6)}`);
  console.log(`- Active generating seats a $499 Institution plan can support before negative margin at 1 STANDARD 150 equivalent per seat: ${maxActiveSeatsBeforeNegativeMargin(499, 1, REWRITTEN_BASELINE_COSTS.standard_150.costPerPdf)}`);
  console.log('');

  console.log('## Price-band break-even reference');
  (Object.keys(HYPOTHETICAL_PRICE_BANDS) as Tier[]).forEach(tier => {
    const expectedScenario = TIER_USAGE_SCENARIOS.find(scenario => scenario.tier === tier && scenario.usageBand === 'expected')!;
    console.log(`### ${titleCase(tier)} expected usage`);
    console.log('');
    console.log(`| Monthly price | Break-even PDFs/mo | Break-even cost/PDF |`);
    console.log(`| ---: | ---: | ---: |`);
    HYPOTHETICAL_PRICE_BANDS[tier].forEach(price => {
      const costPerPdf = REWRITTEN_BASELINE_COSTS[expectedScenario.workload].costPerPdf;
      console.log(`| ${formatCurrency(price)} | ${breakEvenPdfsPerMonth(price, costPerPdf).toFixed(2)} | ${formatCurrency(breakEvenCostPerPdf(price, expectedScenario.pdfsPerMonth))} |`);
    });
    console.log('');
  });
}

function printRecommendationRules(): void {
  console.log('# Recommendation Rules');
  console.log('');
  console.log('- If Student expected margin is below 70%, do not bundle unrestricted private PDF generation into Student.');
  console.log('- If Boards heavy margin is below 50%, require credit metering, lower included generation, or a higher monthly price.');
  console.log('- If Institution margin changes sharply with active generating seats, price it per seat plus a pooled generation allowance, not as flat unlimited usage.');
  console.log('');
}

function printRedZoneTable(redZoneRows: RedZoneRow[]): void {
  console.log('# Red Zone Table');
  console.log('');
  console.log('| Tier | Scenario | Cost sensitivity | Price | Margin $ | Margin % | Zone |');
  console.log('| --- | --- | --- | ---: | ---: | ---: | --- |');

  redZoneRows
    .sort((a, b) => a.marginPercent - b.marginPercent)
    .forEach(row => {
      console.log(`| ${titleCase(row.tier)} | ${row.scenario} | ${titleCase(row.sensitivity)} | ${row.priceLabel} | ${formatCurrency(row.marginDollars)} | ${formatPercent(row.marginPercent)} | ${titleCase(marginZone(row.marginPercent))} |`);
    });

  console.log('');
}

function main(): void {
  const cliArgs = parseArgs();
  const redZoneRows: RedZoneRow[] = [];

  console.log('# Margin Projection Framework');
  console.log('');
  console.log('This report uses contribution margin only and excludes CAC, payroll, support, hosting, and Stripe fees.');
  console.log('Dense medical textbooks are the default workload assumption.');
  console.log('');

  printHypotheticalScenarioTables(redZoneRows);
  printInstitutionOrgTables(redZoneRows);
  printActualPriceFramework(cliArgs);
  printBreakEvenThresholds();
  printRecommendationRules();
  printRedZoneTable(redZoneRows);
}

main();
