import { useEffect, useState } from "react";
import { fetchPyneSecurityPolicy } from "../../services/indicatorApi.js";
import type { PyneSecurityPolicy } from "./indicatorTypes.js";

export function usePyneSecurityPolicy(): PyneSecurityPolicy | null {
  const [securityPolicy, setSecurityPolicy] = useState<PyneSecurityPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPyneSecurityPolicy()
      .then((policy) => {
        if (!cancelled) setSecurityPolicy(policy);
      })
      .catch(() => {
        if (!cancelled) setSecurityPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return securityPolicy;
}
