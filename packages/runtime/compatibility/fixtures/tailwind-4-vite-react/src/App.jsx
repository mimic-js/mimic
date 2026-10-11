import { useState } from 'react';

const plans = [
  { name: 'Hobby', monthly: 0, features: ['1 project', 'Community support'] },
  { name: 'Pro', monthly: 20, features: ['Unlimited projects', 'Priority support'] }
];

export function App() {
  const [yearly, setYearly] = useState(false);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold text-brand">Pricing</h1>
      <label className="mt-4 flex items-center gap-2">
        <input type="checkbox" checked={yearly} onChange={(event) => setYearly(event.target.checked)} />
        Bill yearly
      </label>
      <ul className="mt-6 grid grid-cols-2 gap-4">
        {plans.map((plan) => (
          <li key={plan.name} className="rounded-lg border border-gray-200 p-4 shadow-sm">
            <h2 className="text-xl font-semibold">{plan.name}</h2>
            <p data-price className="mt-2 text-2xl">
              ${yearly ? plan.monthly * 10 : plan.monthly}
              <span className="text-sm text-gray-500">/{yearly ? 'yr' : 'mo'}</span>
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </main>
  );
}
