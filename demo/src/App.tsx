import { Flex } from '@workday/canvas-kit-react/layout';
import { Heading, Text } from '@workday/canvas-kit-react/text';
import { SearchDemo } from './SearchDemo';

export default function App() {
  return (
    <Flex flexDirection="column" alignItems="center" padding={48} gap={8}>
      <Heading size="large">Canvas Icon Search</Heading>
      <Text variant="hint" marginBottom={24}>
        Describe what you're looking for -- no need to know the icon's name, category, or exact tag.
      </Text>
      <SearchDemo />
    </Flex>
  );
}
