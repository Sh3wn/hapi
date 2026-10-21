import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiModelSummary, PiModelsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
export function usePiModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    /** Pi-family product to probe (`pi` or `omp`). */
    flavor?: 'pi' | 'omp'
    enabled?: boolean
}): {
    availableModels: PiModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, machineId } = args
    const flavor = args.flavor ?? 'pi'
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machinePiModels(machineId, flavor)
            : ['machine-pi-models', 'unknown', flavor] as const,
        queryFn: async () => {
            if (!api || !machineId) {
                throw new Error('Pi models target unavailable')
            }
            return await api.getMachinePiModels(machineId, flavor)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Pi models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi models'
                    : null,
    }
}