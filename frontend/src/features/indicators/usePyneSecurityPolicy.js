import { useEffect, useState } from "react";
import { fetchPyneSecurityPolicy } from "../../services/indicatorApi";

export function usePyneSecurityPolicy() {
  const [securityPolicy, setSecurityPolicy] = useState(null);

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
