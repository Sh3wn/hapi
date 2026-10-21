import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listPiModelsForMachine,
    type ListPiModelsForMachineRequest,
    type ListPiModelsForMachineResponse
} from '../piModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerPiModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListPiModelsForMachineRequest, ListPiModelsForMachineResponse>(
        RPC_METHODS.ListPiModelsForMachine,
        async (request) => {
            const flavor = request?.flavor === 'omp' ? 'omp' : 'pi';
            logger.debug(`List ${flavor} models request`);

            try {
                return await listPiModelsForMachine(flavor);
            } catch (error) {
                logger.debug(`Failed to list ${flavor} models:`, error);
                return rpcError(getErrorMessage(error, `Failed to list ${flavor} models`));
            }
        }
    );
}