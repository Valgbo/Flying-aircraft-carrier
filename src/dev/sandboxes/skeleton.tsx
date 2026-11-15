/** Example sandbox: the placeholder ship on the SandboxStage. Open /?sandbox=skeleton */
import Carrier from '../../carrier/Carrier';
import SandboxStage from '../SandboxStage';

export default function SkeletonSandbox() {
  return (
    <SandboxStage>
      <Carrier />
    </SandboxStage>
  );
}
